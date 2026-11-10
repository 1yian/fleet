import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";

const MODEL = "openai-codex/gpt-fixture";
const RATE_LIMITED = "HTTP 429 rate limit exceeded. Retry-After: 10800";

let fleet: Fleet;
let cleo: Session;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const is =
  (condition: string) =>
  (entry: Entry): boolean =>
    entry.fields["condition"] === condition;
const heardBy = (session: Session, condition: string, card?: Card): Entry[] =>
  session.entries
    .map((push) => push.entry)
    .filter((entry) => is(condition)(entry) && (card === undefined || entry.card === card.id));

const reachedTier = (session: Session, card: Card, condition: string, tier: number) =>
  session.waitForEntry(
    (entry) =>
      entry.card === card.id && is(condition)(entry) && Number(entry.fields["tier"]) >= tier,
    `${condition} tier ${String(tier)} on c-${String(card.id)}`,
  );

async function failingWorker(
  card: Card,
  error: string,
  options: { model?: string; mate?: Session } = {},
): Promise<Session> {
  const { model, mate = cleo } = options;
  const plan = check(
    OPS["attempt.begin"].result,
    await mate.call("attempt.begin", {
      card: card.id,
      host: "maverick",
      task: "the task",
      ...(model === undefined ? {} : { model }),
    }),
  );
  const worker = await fleet.cardd.connect(plan.token);
  await worker.call("incident.report", { error });
  return worker;
}

async function incidentHeard(mate: Session): Promise<{ incident: number; generation: number }> {
  const heard = await mate.waitForEntry(is("runtime-failure"), "the runtime failure");
  const found = /Incident (\d+), process generation (\d+)/.exec(heard.body);
  return { incident: Number(found?.[1]), generation: Number(found?.[2]) };
}

const restart = (
  card: Card,
  incident: { incident: number; generation: number },
  rest: Record<string, unknown>,
): Promise<unknown> => cleo.call("card.restart", { card: card.id, ...incident, ...rest });

test("a refused avoid on an explicit model reaches main once after the mate's first reminder, naming the card, lane, incident, and reason, and the mate's reminders go on", async () => {
  const card = await newCard(cleo, "Users see Spanish copy");
  const worker = await failingWorker(card, RATE_LIMITED, { model: MODEL });
  const incident = await incidentHeard(cleo);
  await assert.rejects(
    restart(card, incident, { mode: "replace", avoid: ["openai-codex"], key: "avoid" }),
    /cannot avoid openai-codex/,
  );

  const told = await fleet.main.waitForEntry(
    is("runtime-failure-unrecoverable"),
    "main to hear that no recovery is left",
  );
  const firstReminder = await reachedTier(cleo, card, "runtime-failure-open", 1);
  assert.ok(told.id > firstReminder.id, "main hears after the mate's first reminder");
  assert.equal(told.card, card.id);
  assert.equal(told.kind, "finding");
  assert.ok(!told.body.includes("\n"), told.body);
  for (const part of [
    `c-${String(card.id)} in lane cleo`,
    `incident ${String(incident.incident)}`,
    "HTTP 429",
    `was dispatched on ${MODEL}`,
    "a restart keeps that model",
  ])
    assert.ok(told.body.includes(part), `${part} in: ${told.body}`);

  const last = await reachedTier(cleo, card, "runtime-failure-open", 4);
  assert.ok(last.id > told.id, "the mate's own reminders go on after main was told");
  assert.equal(heardBy(fleet.main, "runtime-failure-unrecoverable", card).length, 1);
  assert.equal(heardBy(fleet.main, "runtime-failure-open", card).length, 0);

  await worker.call("incident.clear", {});
  const witness = await newCard(cleo, "a clock for the test");
  await begin(cleo, witness);
  await reachedTier(cleo, witness, "worker-never-connected", 3);
  assert.equal(heardBy(fleet.main, "runtime-failure-unrecoverable").length, 1);
});

test("a failure whose retry becomes eligible at a known time does not reach main, even when the mate asks for it too early", async () => {
  const card = await newCard(cleo, "Users see Spanish copy");
  await failingWorker(card, RATE_LIMITED, { model: MODEL });
  const incident = await incidentHeard(cleo);
  await assert.rejects(
    restart(card, incident, { mode: "retry", key: "early" }),
    /is not eligible for recovery until/,
  );

  await reachedTier(cleo, card, "runtime-failure-open", 4);
  assert.deepEqual(heardBy(fleet.main, "runtime-failure-unrecoverable"), []);
});

test("a failure that needs no model refusal escalates when its retries are spent, and not before", async () => {
  const card = await newCard(cleo, "Users see one scrollbar");
  const worker = await failingWorker(card, "HTTP 529 overloaded");
  const incident = await incidentHeard(cleo);
  const eligibleNotices = (): Entry[] =>
    heardBy(cleo, "runtime-failure", card).filter((entry) =>
      entry.body.includes("is eligible for recovery now"),
    );
  for (const attempt of [1, 2]) {
    await cleo.waitForEntry(
      (entry) => eligibleNotices()[attempt - 1]?.id === entry.id,
      `eligibility notice ${String(attempt)}`,
    );
    assert.deepEqual(heardBy(fleet.main, "runtime-failure-unrecoverable"), []);
    await restart(card, incident, { mode: "retry", key: `retry-${String(attempt)}` });
    await worker.call("incident.report", { error: "HTTP 529 overloaded" });
  }

  const told = await fleet.main.waitForEntry(
    is("runtime-failure-unrecoverable"),
    "main to hear that the retries are spent",
  );
  assert.match(told.body, /every recovery its class allows is spent \(2 of 2 retries\)/);
  assert.match(told.body, /c-\d+ in lane cleo, incident \d+/);
});

test("bad credentials leave no recovery from the start, and main hears once after the first reminder", async () => {
  const card = await newCard(cleo, "Users see one scrollbar");
  await failingWorker(card, "HTTP 401 invalid api key");

  const told = await fleet.main.waitForEntry(
    is("runtime-failure-unrecoverable"),
    "main to hear about bad credentials",
  );
  const firstReminder = await reachedTier(cleo, card, "runtime-failure-open", 1);
  assert.ok(told.id > firstReminder.id);
  assert.match(told.body, /restarting is not a repair for auth/);
  await reachedTier(cleo, card, "runtime-failure-open", 4);
  assert.equal(heardBy(fleet.main, "runtime-failure-unrecoverable").length, 1);
});

test("a worker in main's own lane is not escalated: main is already its mate", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await failingWorker(card, "HTTP 401 invalid api key", { mate: fleet.main });

  await reachedTier(fleet.main, card, "runtime-failure-open", 3);
  assert.deepEqual(heardBy(fleet.main, "runtime-failure-unrecoverable"), []);
});

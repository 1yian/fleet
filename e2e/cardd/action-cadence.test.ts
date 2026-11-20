import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import {
  ageCards,
  ageEntry,
  begin,
  CheckPasses,
  MINUTE,
  newCard,
  park,
  startFleet,
  type Fleet,
} from "../support/fleet.ts";

const HOUR = 60 * MINUTE;

let fleet: Fleet;
let passes: CheckPasses;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_CHECK_EVERY_MS: "50" });
  passes = await CheckPasses.open(fleet);
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const name = (card: Card): string => `c-${String(card.id)}`;

const list = (session: Session, tier: number): Promise<Entry> =>
  session.waitForEntry(
    (entry) => entry.fields["condition"] === "decisions" && Number(entry.fields["tier"]) >= tier,
    `list ${String(tier)}`,
  );

const lists = (session: Session): Entry[] =>
  session.entries
    .map(({ entry }) => entry)
    .filter((entry) => entry.author === "check" && entry.fields["condition"] === "decisions");

const actingPart = (entry: Entry): string => entry.body.split(/\n(?=Dated waits)/)[0] ?? "";
const watchedPart = (entry: Entry): string => entry.body.split(/\n(?=Dated waits)/)[1] ?? "";

const listed = (text: string): string[] =>
  (text.match(/^- c-\d+/gm) ?? []).map((line) => line.slice(2));

async function afterTenMinutes(
  session: Session,
  tier: number,
  age: (ms: number) => void,
): Promise<Entry> {
  age(9 * MINUTE);
  await passes.next();
  assert.equal(lists(session).length, tier - 1, `list ${String(tier)} came before ten minutes`);
  age(MINUTE);
  return list(session, tier);
}

const report = (session: Session, card: Card, status: string): Promise<Entry> =>
  session.waitForEntry(
    (entry) =>
      entry.card === card.id && entry.kind === "report" && entry.fields["status"] === status,
    `the ${status} report on ${name(card)}`,
  );

test("blocked and needs-decision reports reach the mate at once, and the one list for them comes after ten minutes and every ten minutes", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const stuck = await newCard(cleo, "API is down");
  const asked = await newCard(cleo, "Pick the name");
  const stuckWorker = await fleet.cardd.connect(await begin(cleo, stuck));
  const askedWorker = await fleet.cardd.connect(await begin(cleo, asked));
  await stuckWorker.call("report", { status: "blocked", text: "the API is down" });
  await askedWorker.call("report", { status: "needs-decision", key: "name", text: "Which name?" });

  await report(cleo, stuck, "blocked");
  await report(cleo, asked, "needs-decision");
  assert.deepEqual(lists(cleo), [], "the reports came before any list");

  const first = await afterTenMinutes(cleo, 1, (ms) => {
    ageCards(fleet.cardd, [stuck, asked], ms);
  });
  assert.match(first.body, /^reminder: 2 cards need a decision or action from you\./);
  assert.deepEqual((first.body.match(/c-\d+/g) ?? []).sort(), [name(stuck), name(asked)].sort());

  const second = await afterTenMinutes(cleo, 2, (ms) => {
    ageEntry(fleet.cardd, first.id, ms);
  });
  assert.deepEqual(second.body.match(/c-\d+/g), first.body.match(/c-\d+/g));
  assert.deepEqual(
    cleo.entries
      .map(({ entry }) => entry)
      .filter((entry) => entry.author === "check" && entry.fields["condition"] !== "decisions"),
    [],
    "nothing but the one list is sent for these cards",
  );
});

test("an idle park keeps the ten minute cadence, and a watched wait with healthy running work beside it is not reminded", async () => {
  const { main } = fleet;
  const quinn = await fleet.cardd.connect(fleet.cardd.addLane("quinn", "main"));

  const running = await newCard(quinn, "Healthy work");
  const runner = await fleet.cardd.connect(await begin(quinn, running));
  runner.send({ t: "activity", state: "running", progress: true });
  await runner.call("report", { status: "in-review", text: "checks are running" });
  const followed = await newCard(main, "Waits on the healthy worker");
  await main.call("hold", {
    card: followed.id,
    question: "Is the worker done?",
    until: Date.now() + HOUR,
    worker: running.id,
    remaining: [],
  });

  const gone = await newCard(main, "Worker that goes away");
  await fleet.cardd.connect(await begin(main, gone));
  const parked = await newCard(main, "Parked on a worker that is gone");
  const dated = await newCard(main, "Waits on a date");
  await park(main, dated, "Quota resets?", HOUR);
  await main.call("hold", {
    card: parked.id,
    question: "Is the worker done?",
    until: Date.now() + HOUR,
    worker: gone.id,
    remaining: [],
  });
  await main.call("close.finish", {
    card: gone.id,
    mode: "dropped",
    text: "dropped",
    archives: [],
    left: [],
  });
  const hold = check(CardViewSchema, await main.call("card", { card: parked.id })).entries.find(
    (entry) => entry.kind === "hold",
  );
  assert.ok(hold !== undefined);

  const first = await afterTenMinutes(main, 1, (ms) => {
    ageCards(fleet.cardd, [parked], ms);
  });
  assert.match(first.body, /^reminder: 1 card needs a decision or action from you\./);
  assert.deepEqual(listed(actingPart(first)), [name(parked)]);
  assert.deepEqual(listed(watchedPart(first)).sort(), [followed, dated].map(name).sort());
  assert.ok(!listed(first.body).includes(name(running)), "healthy running work has no line");
  const second = await afterTenMinutes(main, 2, (ms) => {
    ageEntry(fleet.cardd, first.id, ms);
  });
  assert.deepEqual(listed(actingPart(second)), [name(parked)]);

  assert.deepEqual(
    quinn.entries
      .map(({ entry }) => entry)
      .filter((entry) => entry.author === "check")
      .map((entry) => `${String(entry.card)} ${String(entry.fields["condition"])}`),
    [],
    "quinn has only healthy running work, so the check sent it nothing",
  );
});

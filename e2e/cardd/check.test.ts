// The timed check (spec section 13), against a real cardd whose timers run a
// thousand times faster: the check runs every 60 ms, a worker counts as never
// connected or idle after 120 ms, stalled after 900 ms, and reminders come
// after 1.8 s and 3.6 s.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Card, Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const findings = (card: Card): string[] =>
  fleet.main.entries
    .map(({ entry }: { entry: Entry }) => entry)
    .filter((entry) => entry.card === card.id && entry.author === "check")
    .map((entry) => String(entry.fields["condition"]));
const findingFor = (card: Card, condition: string): Promise<Entry> =>
  fleet.main.waitForEntry(
    (entry) => entry.card === card.id && entry.fields["condition"] === condition,
    `${condition} on c-${String(card.id)}`,
  );

async function running(token: string): Promise<Session> {
  const worker = await fleet.cardd.connect(token);
  worker.send({ t: "activity", state: "running" });
  return worker;
}

test("a worker that never connects goes back to its mate, once", async () => {
  const card = await newCard(fleet.main, "never connects");
  await begin(fleet.main, card);
  await findingFor(card, "worker-never-connected");
  assert.equal(await status(fleet.main, card), "with-mate");

  const later = await newCard(fleet.main, "a later card");
  await begin(fleet.main, later);
  await findingFor(later, "worker-never-connected");
  assert.deepEqual(findings(card), ["worker-never-connected"]);
});

test("a worker that disconnects, and a worker that stalls, go back to their mate", async () => {
  const gone = await newCard(fleet.main, "disconnects");
  await (await running(await begin(fleet.main, gone))).close();
  const stuck = await newCard(fleet.main, "stalls");
  await running(await begin(fleet.main, stuck));

  await findingFor(gone, "worker-not-connected");
  await findingFor(stuck, "worker-stalled");
  assert.deepEqual(
    [findings(gone), findings(stuck)],
    [["worker-not-connected"], ["worker-stalled"]],
  );
  assert.deepEqual(
    [await status(fleet.main, gone), await status(fleet.main, stuck)],
    ["with-mate", "with-mate"],
  );
});

test("an idle worker without a handoff goes back to its mate, but a paused one waits", async () => {
  const paused = await newCard(fleet.main, "paused");
  const pausedWorker = await fleet.cardd.connect(await begin(fleet.main, paused));
  const [pausedTask] = await pausedWorker.waitForEntries(1);
  pausedWorker.ack(pausedTask?.id ?? 0);
  await pausedWorker.call("report", {
    status: "paused",
    text: "waiting for the API team",
    until: Date.now() + 3_600_000,
  });
  const idle = await newCard(fleet.main, "idle");
  const idleWorker = await fleet.cardd.connect(await begin(fleet.main, idle));
  const [task] = await idleWorker.waitForEntries(1);
  idleWorker.ack(task?.id ?? 0);

  await findingFor(idle, "worker-idle");
  assert.equal(await status(fleet.main, idle), "with-mate");
  assert.deepEqual(findings(paused), []);
  assert.equal(await status(fleet.main, paused), "working");
});

test("a card that waits on an idle mate gets one reminder for each tier", async () => {
  const card = await newCard(fleet.main, "blocked");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "blocked", text: "the API is down" });

  await findingFor(card, "reminder-2");
  assert.deepEqual(findings(card), ["reminder-1", "reminder-2"]);
  assert.match(
    fleet.main.entries.at(-1)?.entry.body ?? "",
    /^reminder: this card has waited for you \(with-mate, \d+ min\)$/,
  );
});

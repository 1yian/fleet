import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";

const WAIT_MS = 10_000;
const MISSED =
  "missed: cleo did not take in this report from the worker, sent twice: The API is down";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.01" });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

async function blockedInCleo(cleo: Session): Promise<{ card: number; worker: Session }> {
  const card = await newCard(cleo, "Users see one scrollbar");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "blocked", text: "The API is down\nlogs in /tmp/x" });
  return { card: card.id, worker };
}

const sent = (session: Session, kind: Entry["kind"]): [string, boolean][] =>
  session.entries
    .filter(({ entry }) => entry.kind === kind)
    .map(({ entry, again }) => [entry.body, again ?? false]);

async function boardNote(card: number): Promise<Entry> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const { entries } = await fleet.cardd.thread(card);
    const note = entries.find((entry) => entry.kind === "note" && entry.author === "check");
    if (note !== undefined) return note;
    if (Date.now() > deadline) throw new Error("timed out waiting for the board note");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a report a second mate never takes in is sent once more, then goes to main, then to the board", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"), [], false);
  const main = await fleet.cardd.connect(fleet.mainToken, [], false);
  const { card, worker } = await blockedInCleo(cleo);

  const missed = await main.waitForEntry(
    (entry) => entry.fields["condition"] === "missed",
    "main to hear that cleo missed the report",
  );
  assert.equal(missed.body, MISSED);
  assert.equal(
    (await boardNote(card)).body,
    `missed: main did not take in this finding from the check, sent twice: ${MISSED}`,
  );
  assert.deepEqual(sent(cleo, "report"), [
    ["The API is down\nlogs in /tmp/x", false],
    ["The API is down\nlogs in /tmp/x", true],
  ]);
  assert.deepEqual(sent(main, "finding"), [
    [MISSED, false],
    [MISSED, true],
  ]);
  await worker.close();
});

test("a report main takes in is never sent again", async () => {
  const card = await newCard(fleet.main, "Main's own card");
  const mainWorker = await fleet.cardd.connect(await begin(fleet.main, card));
  await mainWorker.call("report", { status: "blocked", text: "Blocked on main's card" });
  await fleet.main.waitForEntry((entry) => entry.kind === "report", "main's report");
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"), [], false);
  const { worker } = await blockedInCleo(cleo);

  await fleet.main.waitForEntry((entry) => entry.body === MISSED, "main to hear cleo missed it");
  assert.deepEqual(sent(fleet.main, "report"), [["Blocked on main's card", false]]);
  await Promise.all([worker.close(), mainWorker.close()]);
});

test("a comment a waiting worker with no running job never takes in is sent once more, then goes to its second mate", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"), [], true);
  const main = await fleet.cardd.connect(fleet.mainToken, [], false);
  const card = await newCard(cleo, "Users see one scrollbar");
  const worker = await fleet.cardd.connect(await begin(cleo, card), [], false);
  worker.send({ t: "activity", state: "waiting" });
  const [task] = await worker.waitForEntries(1);
  worker.ack(task?.id ?? 0);
  await cleo.call("comment", { card: card.id, text: "use the v2 endpoint" });

  const missed = await cleo.waitForEntry(
    (entry) => entry.fields["condition"] === "missed",
    "cleo to hear that the worker missed the comment",
  );
  assert.equal(missed.kind, "finding");
  assert.equal(
    missed.body,
    `missed: the worker on c-${String(card.id)} did not take in this comment from cleo, sent twice: use the v2 endpoint`,
  );
  assert.deepEqual(sent(worker, "comment"), [
    ["the task\n\nDelivery: no-mistakes", false],
    ["use the v2 endpoint", false],
    ["use the v2 endpoint", true],
  ]);
  assert.deepEqual(sent(main, "finding"), []);
  await worker.close();
});

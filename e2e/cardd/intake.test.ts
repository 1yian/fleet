import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";

const MISSED =
  "missed: cleo did not take in this report from the worker, re-sent 3 times: The API is down";

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

test("a report a second mate never takes in is sent again every two minutes, and main hears after the third resend", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"), [], false);
  const main = await fleet.cardd.connect(fleet.mainToken, [], false);
  const { worker } = await blockedInCleo(cleo);

  const missed = await main.waitForEntry(
    (entry) => entry.fields["condition"] === "missed",
    "main to hear that cleo missed the report",
  );
  assert.equal(missed.body, MISSED);
  const resent = sent(cleo, "report");
  assert.deepEqual(resent[0], ["The API is down\nlogs in /tmp/x", false]);
  assert.ok(resent.length >= 4, `cleo was sent the report ${String(resent.length)} times`);
  assert.ok(resent.slice(1).every(([body, again]) => body.startsWith("The API is down") && again));
  const repeated = await main.waitForEntry(
    (entry) =>
      entry.id > missed.id &&
      entry.fields["condition"] === "missed" &&
      entry.fields["entry"] === missed.fields["entry"],
    "main to hear the same unread obligation again after fifteen minutes",
  );
  const elapsed = repeated.createdAt - missed.createdAt;
  assert.ok(
    elapsed >= 9000 && elapsed < 9600,
    `fifteen minutes scaled to nine seconds: ${String(elapsed)} ms`,
  );
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

test("a comment a waiting worker never takes in is resent three times, then main hears", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"), [], true);
  const main = fleet.main;
  const card = await newCard(cleo, "Users see one scrollbar");
  const worker = await fleet.cardd.connect(await begin(cleo, card), [], false);
  worker.send({ t: "activity", state: "waiting" });
  const [task] = await worker.waitForEntries(1);
  worker.ack(task?.id ?? 0);
  await cleo.call("comment", { card: card.id, text: "use the v2 endpoint" });

  const missed = await main.waitForEntry(
    (entry) => entry.fields["condition"] === "missed",
    "main to hear that the worker missed the comment",
  );
  assert.equal(missed.kind, "finding");
  assert.equal(
    missed.body,
    `missed: the worker on c-${String(card.id)} did not take in this comment from cleo, re-sent 3 times: use the v2 endpoint`,
  );
  const sends = sent(worker, "comment");
  assert.deepEqual(sends.slice(0, 3), [
    ["the task\n\nDelivery: no-mistakes", false],
    ["use the v2 endpoint", false],
    ["use the v2 endpoint", true],
  ]);
  assert.ok(sends.length >= 5, `the worker was sent the comment ${String(sends.length - 1)} times`);
  assert.deepEqual(sent(cleo, "finding"), []);
  await worker.close();
});

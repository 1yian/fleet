import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BoardSchema, check, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
});
afterEach(async () => {
  const calls = fleet.cardd.gh.calls();
  await fleet.cardd.stop();
  assert.deepEqual(calls, [], "no wake, report, or close may invoke gh");
});

async function idle(token: string): Promise<Session> {
  const worker = await fleet.cardd.connect(token);
  const [task] = await worker.waitForEntries(1);
  worker.ack(task?.id ?? 0);
  return worker;
}

function nudge(session: Session, card: Card): Promise<Entry> {
  return session.waitForEntry(
    (entry) => entry.card === card.id && entry.fields["condition"] === "worker-idle-nudge",
    `idle nudge on c-${String(card.id)}`,
  );
}

test("a worker resumed from a pause by a comment is watched for idleness at once", async () => {
  const resumed = await newCard(fleet.main, "paused then resumed by a comment");
  const resumedWorker = await idle(await begin(fleet.main, resumed));
  await resumedWorker.call("report", {
    status: "paused",
    text: "waiting",
    until: Date.now() + 3_600_000,
  });
  await fleet.main.call("comment", { card: resumed.id, text: "the wait is over, carry on" });
  const steer = await resumedWorker.waitForEntry(
    (entry) => entry.kind === "comment" && entry.body.includes("the wait is over"),
    "the resume comment",
  );
  resumedWorker.ack(steer.id);
  resumedWorker.send({ t: "activity", state: "idle" });

  const control = await newCard(fleet.main, "idle control, never paused");
  const controlWorker = await idle(await begin(fleet.main, control));
  controlWorker.send({ t: "activity", state: "idle" });

  await nudge(controlWorker, control);
  await nudge(resumedWorker, resumed);
  const board = check(BoardSchema, await fleet.cardd.board());
  const shown = board.cards.find((each) => each.id === resumed.id);
  if (shown === undefined) throw new Error("the resumed card left the board");
  assert.equal(shown.status, "working");
  assert.equal(shown.until, null);
});

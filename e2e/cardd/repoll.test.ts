import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type BoardCard, type Card, type Entry, type Pulse } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { ageCard, begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { until } from "../support/live-fleet.ts";

const SCALE = 0.01;
const MINUTE = 60_000;
const IDLE_LIMIT = 4 * 60 * MINUTE * SCALE;

let fleet: Fleet;
let cleo: Session;
const beats: NodeJS.Timeout[] = [];
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: String(SCALE) });
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
});
afterEach(async () => {
  for (const beat of beats.splice(0)) clearInterval(beat);
  await fleet.cardd.stop();
});

async function onBoard(card: Card): Promise<BoardCard> {
  const found = check(OPS.board.result, await cleo.call("board", {})).find(
    (each) => each.id === card.id,
  );
  if (found === undefined) throw new Error(`c-${String(card.id)} is not on the board`);
  return found;
}

const pulseOf = async (card: Card): Promise<Pulse> => {
  const { pulse } = await onBoard(card);
  if (pulse === null) throw new Error(`c-${String(card.id)} has no pulse`);
  return pulse;
};

async function startJob(worker: Session, label: string, command: string): Promise<number> {
  const started = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label, command }),
  );
  beats.push(
    setInterval(() => {
      worker.call("job.alive", { job: started.job }).catch(() => undefined);
    }, started.heartbeatMs),
  );
  return started.job;
}

async function rePoll(worker: Session, round: number): Promise<number> {
  const job = await startJob(worker, "approval-poll", `poll the page # ${String(round)}`);
  await worker.call("job.finish", { job, exitCode: 124, outputTail: "timed out with no feedback" });
  await worker.call("report", { status: "working", text: `Poll ${String(round)} timed out.` });
  return job;
}

const isList = (entry: Entry): boolean =>
  entry.author === "check" && entry.fields["condition"] === "decisions";

test("a working report that repeats the last one does not move an idle card, and a commit does", async () => {
  const card = await newCard(cleo, "Wait for the approval");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  worker.send({ t: "activity", state: "idle" });
  await worker.call("report", { status: "working", text: "Waiting for the approval." });
  ageCard(fleet.cardd, card, IDLE_LIMIT + MINUTE);

  await worker.call("report", { status: "working", text: "Still waiting for the approval." });
  const stale = await until(async () => {
    const pulse = await pulseOf(card);
    return pulse.state === "idle" ? pulse : undefined;
  }, "the idle pulse");
  assert.equal(stale.notice, "main", "a report that says nothing new is not movement");
  assert.ok(Date.now() - stale.movedAt > IDLE_LIMIT, "the card last moved before the first report");

  worker.send({ t: "activity", state: "running", progress: true });
  worker.send({ t: "activity", state: "idle" });
  const moved = await until(async () => {
    const pulse = await pulseOf(card);
    return Date.now() - pulse.movedAt < MINUTE ? pulse : undefined;
  }, "the card to move on a commit");
  assert.equal(moved.notice, "none");
});

test("a long job that the worker starts again under the same label with nothing changed does not keep a card from going idle", async () => {
  const card = await newCard(cleo, "Wait for the approval");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "working", text: "Waiting for the approval." });
  await rePoll(worker, 1);
  await rePoll(worker, 2);
  const live = await startJob(worker, "approval-poll", "poll the page # 3");
  worker.send({ t: "activity", state: "waiting" });

  const fresh = await newCard(cleo, "Run the long suite");
  const suite = await fleet.cardd.connect(await begin(cleo, fresh));
  const run = await startJob(suite, "suite", "npm test");
  suite.send({ t: "activity", state: "waiting" });

  const age = IDLE_LIMIT + MINUTE;
  ageCard(fleet.cardd, card, age);
  ageCard(fleet.cardd, fresh, age);

  const idle = await until(async () => {
    const pulse = await pulseOf(card);
    return pulse.state === "idle" ? pulse : undefined;
  }, "the repeated poll's idle pulse");
  assert.equal(idle.notice, "main");
  assert.deepEqual(idle.running, {
    by: "job",
    what: `job ${String(live)} (approval-poll), run again with nothing changed`,
  });
  const first = await pulseOf(fresh);
  assert.deepEqual([first.state, first.notice], ["running", "none"], "a first run still covers");
  assert.equal(first.running?.what, `job ${String(run)} (suite)`);

  const list = await fleet.main.waitForEntry(
    (entry) => isList(entry) && entry.body.includes("Wait for the approval"),
    "main's list naming the card",
  );
  assert.match(
    list.body,
    new RegExp(
      `c-${String(card.id)} Wait for the approval - idle \\d+ min, only a job that repeats a wait, and no stated reason`,
    ),
  );
  assert.doesNotMatch(list.body, /Run the long suite/);

  worker.send({ t: "activity", state: "running", progress: true });
  worker.send({ t: "activity", state: "waiting" });
  const covered = await until(async () => {
    const pulse = await pulseOf(card);
    return pulse.state === "running" ? pulse : undefined;
  }, "the card to run again once something changed");
  assert.equal(covered.notice, "none");
});

test("a note after a working report is news, and a re-run that exits differently moves the card", async () => {
  const card = await newCard(cleo, "Wait for the approval");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  worker.send({ t: "activity", state: "idle" });
  await worker.call("report", { status: "working", text: "Looking into it." });
  ageCard(fleet.cardd, card, IDLE_LIMIT + MINUTE);
  await worker.call("report", { status: "note", text: "Found the cause in the loader." });
  const noted = await until(async () => {
    const pulse = await pulseOf(card);
    return Date.now() - pulse.movedAt < MINUTE ? pulse : undefined;
  }, "the note to move the card");
  assert.equal(noted.notice, "none");

  await rePoll(worker, 1);
  await rePoll(worker, 2);
  ageCard(fleet.cardd, card, IDLE_LIMIT + MINUTE);
  const repeat = await startJob(worker, "approval-poll", "poll the page # 3");
  await worker.call("job.finish", { job: repeat, exitCode: 124, outputTail: "timed out" });
  const stale = await until(async () => {
    const pulse = await pulseOf(card);
    return pulse.state === "idle" ? pulse : undefined;
  }, "the repeated timeouts to leave the card idle");
  assert.ok(Date.now() - stale.movedAt > IDLE_LIMIT, "repeated timeouts are not movement");

  const passed = await startJob(worker, "approval-poll", "poll the page # 4");
  await worker.call("job.finish", { job: passed, exitCode: 0, outputTail: "feedback arrived" });
  const moved = await until(async () => {
    const pulse = await pulseOf(card);
    return Date.now() - pulse.movedAt < MINUTE ? pulse : undefined;
  }, "the passing re-run to move the card");
  assert.equal(moved.notice, "none");
});

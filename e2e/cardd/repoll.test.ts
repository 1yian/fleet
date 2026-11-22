import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type BoardCard, type Card, type Entry, type Pulse } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import {
  ageCard,
  begin,
  lastReportAt,
  newCard,
  pastClock,
  registeredAt,
  startFleet,
  type Fleet,
} from "../support/fleet.ts";
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

test("delivered startup fences do not advance card movement, but an executed job does", async () => {
  const card = await newCard(cleo, "Run the suite");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "working", text: "Preparing the suite." });
  ageCard(fleet.cardd, card, IDLE_LIMIT + MINUTE);
  const before = await pulseOf(card);
  assert.equal(before.state, "idle");
  for (let i = 0; i < 2; i += 1) {
    const { job } = check(
      OPS["job.prepare"].result,
      await worker.call("job.prepare", {
        label: "suite",
        command: "npm test",
        launch: randomUUID(),
      }),
    );
    assert.deepEqual(await worker.call("job.stop", { job }), {
      label: "suite",
      running: false,
      cancelled: true,
    });
    await worker.waitForEntry(
      (entry) =>
        entry.kind === "job-result" &&
        entry.fields["job"] === job &&
        entry.fields["exitCode"] === 130,
      "the fenced reservation's durable result",
    );
  }
  const still = await pulseOf(card);
  assert.deepEqual([still.state, still.movedAt], ["idle", before.movedAt]);

  const launch = randomUUID();
  const { job } = check(
    OPS["job.prepare"].result,
    await worker.call("job.prepare", {
      label: "suite",
      command: "npm test",
      launch,
    }),
  );
  assert.deepEqual(await worker.call("job.register", { job, launch, pid: 1234 }), {
    registered: true,
  });
  await worker.call("job.finish", { job, exitCode: 0, outputTail: "suite passed" });
  const result = await worker.waitForEntry(
    (entry) =>
      entry.kind === "job-result" && entry.fields["job"] === job && entry.fields["exitCode"] === 0,
    "the completed suite's result",
  );
  assert.ok(result.createdAt > before.movedAt);
  assert.equal((await pulseOf(card)).movedAt, result.createdAt);
});

test("a restart notice, even for a start that was refused, does not advance card movement, but a mate's comment does", async () => {
  const card = await newCard(cleo, "Wait for the approval");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "working", text: "Waiting for the approval." });
  ageCard(fleet.cardd, card, IDLE_LIMIT + MINUTE);
  const before = await pulseOf(card);
  assert.deepEqual([before.state, before.notice], ["idle", "main"]);

  const key = "refused-start";
  const { request } = check(
    OPS["card.restart"].result,
    await cleo.call("card.restart", { card: card.id, mode: "replace", key }),
  );
  assert.ok(request !== undefined);
  assert.deepEqual(await cleo.call("card.restart.notice", { card: card.id, request }), {
    posted: true,
  });
  const notice = await worker.waitForEntry(
    (entry) => entry.fields["restartNotice"] === request,
    "the restart notice",
  );
  assert.deepEqual(await cleo.call("card.restart.failed", { card: card.id, key, request }), {
    recorded: true,
  });
  const still = await pulseOf(card);
  assert.deepEqual(
    [still.state, still.notice, still.movedAt],
    ["idle", "main", before.movedAt],
    "a refused restart is not worker progress",
  );
  assert.ok((await fleet.cardd.thread(card.id)).entries.some(({ id }) => id === notice.id));

  await cleo.call("comment", { card: card.id, text: "Check the footer as well." });
  const moved = await pulseOf(card);
  assert.ok(moved.movedAt > before.movedAt, "an ordinary comment still moves the card");
  assert.equal(moved.notice, "none");
});

test("a revival before a wrapper's no-start result does not advance card movement", async () => {
  const card = await newCard(cleo, "Run the suite");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "working", text: "Preparing the suite." });
  ageCard(fleet.cardd, card, IDLE_LIMIT + MINUTE);
  const before = await pulseOf(card);
  assert.equal(before.state, "idle");
  const job = await registered(worker, "suite", 4321);
  await worker.waitForEntry(
    (entry) =>
      entry.kind === "job-result" && entry.fields["job"] === job && entry.fields["lost"] === true,
    "the silent wrapper's loss",
  );
  await worker.call("job.alive", { job });
  await worker.waitForEntry(
    (entry) =>
      entry.kind === "job-result" &&
      entry.fields["job"] === job &&
      entry.fields["revived"] === true,
    "the wrapper's revival",
  );
  const revived = await pulseOf(card);
  assert.equal(revived.movedAt, before.movedAt);
  await worker.call("job.finish", {
    job,
    exitCode: 127,
    outputTail: "could not start: cardd did not confirm wrapper registration",
    commandNotStarted: true,
  });
  await worker.waitForEntry(
    (entry) =>
      entry.kind === "job-result" &&
      entry.fields["job"] === job &&
      entry.fields["commandNotStarted"] === true,
    "the wrapper's no-start result",
  );
  const still = await pulseOf(card);
  assert.deepEqual([still.state, still.movedAt], ["idle", before.movedAt]);
});

async function registered(worker: Session, label: string, pid: number): Promise<number> {
  const launch = randomUUID();
  const { job } = check(
    OPS["job.prepare"].result,
    await worker.call("job.prepare", { label, command: `run ${label}`, launch }),
  );
  assert.deepEqual(await worker.call("job.register", { job, launch, pid }), { registered: true });
  return job;
}

test("repeat accounting counts a registered job from its first registration, which a replay cannot move", async () => {
  const late = await newCard(cleo, "Reserve before the note");
  const lateWorker = await fleet.cardd.connect(await begin(cleo, late));
  await lateWorker.call("report", { status: "working", text: "Preparing the suite." });
  const lateLaunch = randomUUID();
  const reserved = check(
    OPS["job.prepare"].result,
    await lateWorker.call("job.prepare", {
      label: "suite",
      command: "npm test",
      launch: lateLaunch,
    }),
  );
  await lateWorker.call("report", {
    status: "note",
    text: "Found the cause while the launch waited.",
  });
  const lateNote = lastReportAt(fleet.cardd, late);
  pastClock(lateNote);
  assert.deepEqual(
    await lateWorker.call("job.register", { job: reserved.job, launch: lateLaunch, pid: 4100 }),
    { registered: true },
  );
  assert.ok(registeredAt(fleet.cardd, reserved.job) > lateNote);
  await lateWorker.call("job.finish", { job: reserved.job, exitCode: 0, outputTail: "passed" });
  const retry = await registered(lateWorker, "suite", 4101);
  const again = await pulseOf(late);
  assert.deepEqual(again.running, {
    by: "job",
    what: `job ${String(retry)} (suite), run again with nothing changed`,
  });

  const replayed = await newCard(cleo, "Replay the registration");
  const replayWorker = await fleet.cardd.connect(await begin(cleo, replayed));
  await replayWorker.call("report", { status: "working", text: "Preparing the suite." });
  const replayLaunch = randomUUID();
  const first = check(
    OPS["job.prepare"].result,
    await replayWorker.call("job.prepare", {
      label: "suite",
      command: "npm test",
      launch: replayLaunch,
    }),
  );
  await replayWorker.call("job.register", { job: first.job, launch: replayLaunch, pid: 4200 });
  const firstRegistered = registeredAt(fleet.cardd, first.job);
  pastClock(firstRegistered);
  await replayWorker.call("report", { status: "note", text: "Found the cause after registering." });
  const replayNote = lastReportAt(fleet.cardd, replayed);
  assert.ok(replayNote > firstRegistered);
  pastClock(replayNote);
  assert.deepEqual(
    await replayWorker.call("job.register", {
      job: first.job,
      launch: replayLaunch,
      pid: 4200,
    }),
    { registered: true },
  );
  assert.equal(registeredAt(fleet.cardd, first.job), firstRegistered);
  await replayWorker.call("job.finish", { job: first.job, exitCode: 0, outputTail: "passed" });
  const next = await registered(replayWorker, "suite", 4201);
  assert.deepEqual((await pulseOf(replayed)).running, {
    by: "job",
    what: `job ${String(next)} (suite)`,
  });
});

test("repeat accounting follows registration order, not reservation order, for overlapping same-label launches", async () => {
  const card = await newCard(cleo, "Launch the suite twice");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "working", text: "Preparing both suites." });
  const reserve = async (command: string) => {
    const launch = randomUUID();
    const { job } = check(
      OPS["job.prepare"].result,
      await worker.call("job.prepare", { label: "suite", command, launch }),
    );
    return { job, launch };
  };
  const first = await reserve("npm test -- a");
  const second = await reserve("npm test -- b");
  assert.ok(second.job > first.job);
  await worker.call("report", {
    status: "note",
    text: "Found the cause while both launches waited.",
  });
  const note = lastReportAt(fleet.cardd, card);
  pastClock(note);
  const register = (run: { job: number; launch: string }, pid: number) =>
    worker.call("job.register", { job: run.job, launch: run.launch, pid });
  assert.deepEqual(await register(second, 4300), { registered: true });
  const secondRegistered = registeredAt(fleet.cardd, second.job);
  pastClock(secondRegistered);
  assert.deepEqual(await register(first, 4301), { registered: true });
  const firstRegistered = registeredAt(fleet.cardd, first.job);
  assert.ok(secondRegistered > note);
  assert.ok(firstRegistered > secondRegistered);
  await worker.call("job.finish", { job: second.job, exitCode: 0, outputTail: "passed" });

  assert.deepEqual((await pulseOf(card)).running, {
    by: "job",
    what: `job ${String(first.job)} (suite), run again with nothing changed`,
  });
});

test("a repeated poll and a fresh suite on one card: the suite covers, and both jobs are counted", async () => {
  const card = await newCard(cleo, "Wait and test");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "working", text: "Waiting for the approval." });
  await rePoll(worker, 1);
  const poll = await startJob(worker, "approval-poll", "poll the page # 2");
  const suite = await startJob(worker, "suite", "npm test");
  worker.send({ t: "activity", state: "waiting" });
  ageCard(fleet.cardd, card, IDLE_LIMIT + MINUTE);

  const pulse = await until(async () => {
    const found = await pulseOf(card);
    return found.running?.what.includes("more") === true ? found : undefined;
  }, "the pulse to count both jobs");
  assert.equal(pulse.state, "running");
  assert.equal(pulse.notice, "none");
  assert.equal(pulse.running?.what, `job ${String(suite)} (suite) and 1 more`);
  assert.ok(poll < suite);
});

test("after a re-run that exits differently, the next run of that label is a first run again", async () => {
  const card = await newCard(cleo, "Wait for the approval");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "working", text: "Waiting for the approval." });
  await rePoll(worker, 1);
  await rePoll(worker, 2);
  const passed = await startJob(worker, "approval-poll", "poll the page # 3");
  await worker.call("job.finish", { job: passed, exitCode: 0, outputTail: "feedback arrived" });
  await startJob(worker, "approval-poll", "poll the page # 4");
  worker.send({ t: "activity", state: "waiting" });

  const pulse = await until(async () => {
    const found = await pulseOf(card);
    return found.state === "running" ? found : undefined;
  }, "the run after the changed exit to cover the card");
  assert.equal(pulse.notice, "none");
  assert.match(pulse.running?.what ?? "", /^job \d+ \(approval-poll\)$/);
});

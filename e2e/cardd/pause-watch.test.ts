import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { BoardSchema, CardViewSchema, check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import {
  ageBatch,
  ageCard,
  ageEntry,
  ageDated,
  ageSession,
  begin,
  CheckPasses,
  MINUTE,
  newCard,
  startFleet,
  type Fleet,
} from "../support/fleet.ts";

const PAUSE_MS = 60 * MINUTE;
const PAUSE_ENDED = PAUSE_MS + 10 * MINUTE;

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_CHECK_EVERY_MS: "50" });
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
    until: Date.now() + PAUSE_MS,
  });
  await fleet.main.call("comment", { card: resumed.id, text: "the wait is over, carry on" });
  const steer = await resumedWorker.waitForEntry(
    (entry) => entry.kind === "comment" && entry.body.includes("the wait is over"),
    "the resume comment",
  );
  resumedWorker.ack(steer.id);
  resumedWorker.send({ t: "activity", state: "idle" });
  await resumedWorker.call("jobs", {});

  const control = await newCard(fleet.main, "idle control, never paused");
  const controlWorker = await idle(await begin(fleet.main, control));
  controlWorker.send({ t: "activity", state: "idle" });
  await controlWorker.call("jobs", {});

  ageSession(fleet.cardd, resumed, 3 * MINUTE);
  ageSession(fleet.cardd, control, 3 * MINUTE);
  await nudge(controlWorker, control);
  await nudge(resumedWorker, resumed);
  const board = check(BoardSchema, await fleet.cardd.board());
  const shown = board.cards.find((each) => each.id === resumed.id);
  if (shown === undefined) throw new Error("the resumed card left the board");
  assert.equal(shown.status, "working");
  assert.equal(shown.until, null);
});

test("a suppressed restart notice does not block the idle nudge and is delivered on refund", async () => {
  const { main, cardd } = fleet;
  const passes = await CheckPasses.open(fleet);
  const card = await newCard(main, "Check the idle worker during a refundable restart");
  const token = await begin(main, card);
  const first = await cardd.connect(token, [], true, true);
  const [task] = await first.waitForEntries(1);
  assert.ok(task !== undefined);
  await first.call("jobs", {});
  await first.close();

  const restart = async (key: string) => {
    const { request } = check(
      OPS["card.restart"].result,
      await main.call("card.restart", { card: card.id, mode: "replace", key }),
    );
    assert.ok(request !== undefined);
    return request;
  };
  const older = await restart("older");
  assert.deepEqual(await main.call("card.restart.notice", { card: card.id, request: older }), {
    posted: true,
  });
  const request = await restart("successor");
  const worker = await cardd.connect(token, [task.id]);
  ageSession(cardd, card, 3 * MINUTE);
  await passes.next();
  await worker.call("jobs", {});
  assert.match(
    worker.entries.find(({ entry }) => entry.fields["condition"] === "worker-idle-nudge")?.entry
      .body ?? "",
    /^reminder: you went idle without reporting\./,
  );
  assert.deepEqual(
    worker.entries.filter(({ entry }) => entry.fields["restartNotice"] === older),
    [],
  );

  assert.deepEqual(
    await main.call("card.restart.failed", { card: card.id, key: "successor", request }),
    { recorded: true },
  );
  const notice = await worker.waitForEntry(
    (entry) => entry.fields["restartNotice"] === older,
    "the older restart notice on the same connection after refund",
  );
  assert.match(notice.body, /^Your session was restarted on the same card and conversation\./);
});

const isPause = (entry: Entry): boolean =>
  entry.kind === "report" && entry.fields["status"] === "paused";

const listing = (session: Session, text: string, what: string): Promise<Entry> =>
  session.waitForEntry(
    (entry) =>
      entry.author === "check" &&
      entry.fields["condition"] === "decisions" &&
      entry.body.includes(text),
    what,
  );

const pauseOf = async (worker: Session, text: string, until: number) =>
  check(OPS.report.result, await worker.call("report", { status: "paused", text, until }));

async function pausedWorker(
  mate: Session,
  title: string,
): Promise<{ card: Card; worker: Session }> {
  const card = await newCard(mate, title);
  const worker = await fleet.cardd.connect(await begin(mate, card));
  await worker.call("report", { status: "working", text: `starting ${title}` });
  return { card, worker };
}

test("an outstanding dispatch counts for pause advice, dated holds, and idle checks until fenced", async () => {
  const { main, cardd } = fleet;
  const card = await newCard(main, "Start a report export");
  const worker = await idle(await begin(main, card));
  await worker.call("report", { status: "working", text: "Starting the export" });
  const { job } = check(
    OPS["job.prepare"].result,
    await worker.call("job.prepare", {
      launch: randomUUID(),
      label: "export",
      command: "export-report",
    }),
  );
  assert.deepEqual(await worker.call("jobs", {}), []);

  const control = await newCard(main, "Idle without a dispatch");
  const controlWorker = await idle(await begin(main, control));
  await controlWorker.call("jobs", {});
  ageSession(cardd, card, 3 * MINUTE);
  ageSession(cardd, control, 3 * MINUTE);
  await nudge(controlWorker, control);
  const view = async (c: Card) => check(CardViewSchema, await main.call("card", { card: c.id }));
  assert.deepEqual(
    (await view(card)).entries.filter((entry) => entry.fields["condition"] === "worker-idle-nudge"),
    [],
  );

  const until = Date.now() + PAUSE_MS;
  const paused = await pauseOf(worker, "Waiting for the export", until);
  assert.equal(paused.status, "paused");
  assert.equal(paused.advice, undefined);
  const held = await newCard(main, "Use the exported report");
  const hold = { card: held.id, question: "Wait for the export?", until, job, remaining: [] };
  await main.call("hold", hold);
  const wait = async () => {
    const dated = (await view(held)).card.datedWait;
    return [dated?.watch, dated?.what];
  };
  const named = `job ${String(job)} (export)`;
  assert.deepEqual(await wait(), ["running", named]);

  assert.deepEqual(await worker.call("job.stop", { job }), {
    label: "export",
    running: false,
    cancelled: true,
  });
  const fence = await worker.waitForEntry(
    (entry) => entry.kind === "job-result" && entry.fields["job"] === job,
    "the confirmed terminal result",
  );
  assert.equal(fence.fields["startupFenced"], true);
  worker.read(fence.id);
  worker.ack(fence.id);
  assert.deepEqual(await wait(), ["gone", `${named} is finished`]);
  await assert.rejects(main.call("hold", hold), /a dated hold needs a watcher that runs now/);
  const unwatched = await pauseOf(worker, "The export was cancelled", until);
  assert.match(unwatched.advice ?? "", /^Nothing runs for this pause\./);
  ageBatch(cardd, "main", 6 * MINUTE);
  const notice = await main.waitForEntry(
    (entry) => entry.card === card.id && isPause(entry),
    "the unwatched pause",
  );
  assert.equal(notice.body, "The export was cancelled");

  await worker.call("report", { status: "working", text: "Looking for another export" });
  worker.send({ t: "activity", state: "idle" });
  await worker.call("jobs", {});
  ageSession(cardd, card, 3 * MINUTE);
  const idleAfterFence = await nudge(worker, card);
  assert.ok(idleAfterFence.id > fence.id);
});

test("a pause with nothing running reaches its mate, and its end is listed for action", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const passes = await CheckPasses.open(fleet);

  const watched = await newCard(cleo, "Transcode the archive");
  const watchedToken = await begin(cleo, watched);
  const watcher = await fleet.cardd.connect(watchedToken);
  const job = check(
    OPS["job.start"].result,
    await watcher.call("job.start", { label: "transcode", command: "transcode archive" }),
  ).job;
  await watcher.call("report", { status: "working", text: "transcoding" });
  const behindJob = await pauseOf(
    watcher,
    "the transcode finishes by itself",
    Date.now() + PAUSE_MS,
  );
  assert.equal(behindJob.advice, undefined, "a pause behind a running job is told nothing");

  const card = await newCard(cleo, "Render the intro clip");
  const token = await begin(cleo, card);
  const worker = await fleet.cardd.connect(token, [], false);
  const [task] = await worker.waitForEntries(1);
  worker.ack(task?.id ?? 0);
  const submit = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "submit", command: "submit once" }),
  ).job;
  await worker.call("job.finish", { job: submit, exitCode: 0, outputTail: "" });
  const result = await worker.waitForEntry(
    (entry) => entry.kind === "job-result",
    "its job result",
  );
  worker.read(result.id);
  await worker.call("report", { status: "working", text: "the render is PENDING" });
  const until = Date.now() + PAUSE_MS;
  const waiting = "waiting for the provider before the next status read";
  const told = await pauseOf(worker, waiting, until);
  worker.send({ t: "activity", state: "idle" });
  ageBatch(fleet.cardd, "cleo", 6 * MINUTE);

  const heard = await cleo.waitForEntry(isPause, "the paused report");
  assert.match(told.advice ?? "", /^Nothing runs for this pause\..*start a run_long watcher/);
  assert.equal(heard.card, card.id);
  assert.equal(heard.body, waiting);
  assert.ok(Date.now() < until, "the paused report came before its date");
  assert.deepEqual(
    cleo.entries.map(({ entry }) => entry).filter(isPause),
    [heard],
    "the pause behind a running job was not sent",
  );
  await passes.next();
  assert.deepEqual(
    cleo.entries.map(({ entry }) => entry).filter((entry) => entry.author === "check"),
    [],
    "nothing is listed before the date",
  );

  await watcher.call("job.alive", { job });
  ageDated(fleet.cardd, [watched, card], PAUSE_ENDED);
  const list = await listing(cleo, "pause ended", "the list that names the ended pause");
  assert.ok(list.createdAt >= until - PAUSE_ENDED, "the list came after the date");
  assert.match(list.body, /^reminder: 1 card needs a decision or action from you\./);
  assert.ok(
    list.body.includes(
      `- c-${String(card.id)} Render the intro clip - its worker's pause ended 10 min ago and nothing ran since: "${waiting}"`,
    ),
    list.body,
  );
  assert.ok(!list.body.includes(watched.title), "the pause behind a running job is not listed");
});

test("a listed pause ends when its worker reports or its mate steers, and the other lists go on", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const reported = await pausedWorker(cleo, "Pause ended by a report");
  const steered = await pausedWorker(cleo, "Pause ended by a steer");
  const until = Date.now() + PAUSE_MS;
  await pauseOf(reported.worker, "waiting on the provider", until);
  await pauseOf(steered.worker, "waiting on the render", until);
  ageDated(fleet.cardd, [reported.card, steered.card], PAUSE_ENDED);

  const both = await cleo.waitForEntry(
    (entry) =>
      entry.fields["condition"] === "decisions" &&
      entry.body.includes(reported.card.title) &&
      entry.body.includes(steered.card.title),
    "the list of both ended pauses",
  );
  assert.ok(both.createdAt >= until - PAUSE_ENDED);

  await reported.worker.call("report", { status: "note", text: "still waiting, nothing to do" });
  await cleo.call("comment", { card: steered.card.id, text: "the wait is over, carry on" });
  const stuck = await newCard(cleo, "Needs a decision");
  const stuckWorker = await fleet.cardd.connect(await begin(cleo, stuck));
  await stuckWorker.call("report", { status: "blocked", text: "the API is down" });
  ageCard(fleet.cardd, stuck, 10 * MINUTE);
  ageEntry(fleet.cardd, both.id, 10 * MINUTE);

  const after = await listing(cleo, stuck.title, "the next list, with the blocked card");
  assert.ok(!after.body.includes(reported.card.title), "a later worker report ended its pause");
  assert.ok(!after.body.includes(steered.card.title), "a steer ended its pause");
});

test("a watcher that only repeats its earlier run does not hide an ended pause from the mate", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const { card, worker } = await pausedWorker(cleo, "Watch the provider");
  const waiting = "waiting for the provider";
  await pauseOf(worker, waiting, Date.now() + PAUSE_MS);
  for (const round of [1, 2]) {
    const job = check(
      OPS["job.start"].result,
      await worker.call("job.start", {
        label: "provider-watch",
        command: `watch # ${String(round)}`,
      }),
    ).job;
    if (round === 1) await worker.call("job.finish", { job, exitCode: 124, outputTail: "" });
  }
  worker.send({ t: "activity", state: "waiting" });
  ageDated(fleet.cardd, [card], PAUSE_ENDED);

  const list = await listing(cleo, "pause ended", "the list that names the ended pause");
  assert.ok(list.body.includes(`c-${String(card.id)} Watch the provider`), list.body);
});

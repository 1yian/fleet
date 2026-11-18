import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BoardSchema, check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";

const PAUSE_MS = 3_000;

let fleet: Fleet;
let beats: NodeJS.Timeout[] = [];
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
});
afterEach(async () => {
  for (const beat of beats) clearInterval(beat);
  beats = [];
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

test("a pause with nothing running reaches its mate, and its end is listed for action", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));

  const watched = await newCard(cleo, "Transcode the archive");
  const watchedToken = await begin(cleo, watched);
  const watcher = await fleet.cardd.connect(watchedToken);
  const job = check(
    OPS["job.start"].result,
    await watcher.call("job.start", { label: "transcode", command: "transcode archive" }),
  ).job;
  beats.push(
    setInterval(() => {
      watcher.call("job.alive", { job }).catch(() => undefined);
    }, 20),
  );
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
  assert.deepEqual(
    cleo.entries.map(({ entry }) => entry).filter((entry) => entry.author === "check"),
    [],
    "nothing is listed before the date",
  );

  const list = await listing(cleo, "pause ended", "the list that names the ended pause");
  assert.ok(list.createdAt >= until, "the list came after the date");
  assert.match(list.body, /^reminder: 1 card needs a decision or action from you\./);
  assert.ok(
    list.body.includes(
      `- c-${String(card.id)} Render the intro clip - its worker's pause ended 0 min ago and nothing ran since: "${waiting}"`,
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

  const both = await cleo.waitForEntry(
    (entry) =>
      entry.fields["condition"] === "decisions" &&
      entry.body.includes(reported.card.title) &&
      entry.body.includes(steered.card.title),
    "the list of both ended pauses",
  );
  assert.ok(both.createdAt >= until);

  await reported.worker.call("report", { status: "note", text: "still waiting, nothing to do" });
  await cleo.call("comment", { card: steered.card.id, text: "the wait is over, carry on" });
  const stuck = await newCard(cleo, "Needs a decision");
  const stuckWorker = await fleet.cardd.connect(await begin(cleo, stuck));
  await stuckWorker.call("report", { status: "blocked", text: "the API is down" });

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
    else
      beats.push(
        setInterval(() => {
          worker.call("job.alive", { job }).catch(() => undefined);
        }, 20),
      );
  }
  worker.send({ t: "activity", state: "waiting" });

  const list = await listing(cleo, "pause ended", "the list that names the ended pause");
  assert.ok(list.body.includes(`c-${String(card.id)} Watch the provider`), list.body);
});

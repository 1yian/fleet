import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

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

const findings = async (card: Card): Promise<Entry[]> =>
  check(CardViewSchema, await fleet.main.call("card", { card: card.id })).entries.filter(
    (entry) => entry.kind === "finding" && entry.author === "check",
  );
const tiersOf = async (card: Card, condition: string): Promise<number[]> =>
  (await findings(card))
    .filter((entry) => entry.fields["condition"] === condition)
    .map((entry) => Number(entry.fields["tier"]));
const inOrder = (tiers: readonly number[]): number[] => tiers.map((_, at) => at + 1);

const reach = (session: Session, card: Card, condition: string, tier: number): Promise<Entry> =>
  session.waitForEntry(
    (entry) =>
      entry.card === card.id &&
      entry.fields["condition"] === condition &&
      Number(entry.fields["tier"]) >= tier,
    `${condition} tier ${String(tier)} on c-${String(card.id)}`,
  );

async function metronome(ticks: number): Promise<void> {
  const card = await newCard(fleet.main, "a clock for the test");
  await begin(fleet.main, card);
  await reach(fleet.main, card, "worker-never-connected", ticks);
}

function heartbeat(worker: Session, progress: boolean): void {
  const send = (): void => {
    worker.send({ t: "activity", state: "running", ...(progress ? { progress } : {}) });
  };
  send();
  beats.push(setInterval(send, 40));
}

async function idle(token: string): Promise<Session> {
  const worker = await fleet.cardd.connect(token);
  const [task] = await worker.waitForEntries(1);
  worker.ack(task?.id ?? 0);
  return worker;
}

test("a worker that never connects is reminded to its mate at once, then again each tier, one reminder at a time, until it connects", async () => {
  const card = await newCard(fleet.main, "never connects");
  const token = await begin(fleet.main, card);
  await reach(fleet.main, card, "worker-never-connected", 3);
  assert.equal(await status(fleet.main, card), "working");
  const sent = await tiersOf(card, "worker-never-connected");
  assert.deepEqual(sent, inOrder(sent));

  await idle(token);
  const before = (await tiersOf(card, "worker-never-connected")).length;
  await metronome(4);
  assert.equal((await tiersOf(card, "worker-never-connected")).length, before);
});

test("a worker that disconnects is reminded each tier until it is back, and a stalled one likewise, and neither moves the card", async () => {
  const gone = await newCard(fleet.main, "disconnects");
  const goneWorker = await fleet.cardd.connect(await begin(fleet.main, gone));
  goneWorker.send({ t: "activity", state: "running" });
  await goneWorker.close();
  const stuck = await newCard(fleet.main, "stalls");
  const stuckWorker = await fleet.cardd.connect(await begin(fleet.main, stuck));
  stuckWorker.send({ t: "activity", state: "running" });

  await reach(fleet.main, gone, "worker-not-connected", 2);
  await reach(fleet.main, stuck, "worker-stalled", 2);
  assert.deepEqual(
    [await status(fleet.main, gone), await status(fleet.main, stuck)],
    ["working", "working"],
  );
});

test("a running tool that keeps producing output is never a stall, and a long turn with no report, commit, or file change is spinning", async () => {
  const quiet = await newCard(fleet.main, "stalls");
  const quietWorker = await fleet.cardd.connect(await begin(fleet.main, quiet));
  quietWorker.send({ t: "activity", state: "running" });
  const spinning = await newCard(fleet.main, "long turn with nothing to show");
  heartbeat(await fleet.cardd.connect(await begin(fleet.main, spinning)), false);
  const working = await newCard(fleet.main, "long turn that commits");
  heartbeat(await fleet.cardd.connect(await begin(fleet.main, working)), true);

  await reach(fleet.main, spinning, "worker-spinning", 1);
  await reach(fleet.main, quiet, "worker-stalled", 1);
  assert.deepEqual(await tiersOf(spinning, "worker-stalled"), []);
  assert.deepEqual(await tiersOf(working, "worker-stalled"), []);
  assert.deepEqual(await tiersOf(working, "worker-spinning"), []);
});

test("an idle worker is nudged itself once, and its mate hears only when it is still idle after the nudge, then each tier", async () => {
  const card = await newCard(fleet.main, "idle");
  const worker = await idle(await begin(fleet.main, card));

  const nudge = await reach(worker, card, "worker-idle-nudge", 1);
  assert.match(nudge.body, /^reminder: you went idle without reporting\./);
  worker.ack(nudge.id);
  assert.deepEqual(await tiersOf(card, "worker-idle"), []);

  await reach(fleet.main, card, "worker-idle", 2);
  const told = await tiersOf(card, "worker-idle");
  assert.deepEqual(told, inOrder(told));
  assert.equal(await status(fleet.main, card), "working");
  assert.equal(
    worker.entries.filter(({ entry }) => entry.fields["condition"] === "worker-idle-nudge").length,
    1,
  );
});

test("a worker that answers every nudge with a short turn and no report is still reported to its mate", async () => {
  const card = await newCard(fleet.main, "answers nudges without reporting");
  const worker = await idle(await begin(fleet.main, card));
  let answered = 0;
  const answer = setInterval(() => {
    const nudges = worker.entries.filter(
      ({ entry }) => entry.fields["condition"] === "worker-idle-nudge",
    );
    if (nudges.length <= answered) return;
    answered = nudges.length;
    worker.ack(nudges[nudges.length - 1]?.entry.id ?? 0);
    worker.send({ t: "activity", state: "running" });
    setTimeout(() => {
      worker.send({ t: "activity", state: "idle" });
    }, 40);
  }, 5);
  beats.push(answer);

  await reach(worker, card, "worker-idle-nudge", 1);
  await reach(fleet.main, card, "worker-idle", 1);
  assert.equal(await status(fleet.main, card), "working");
});

test("a paused worker is neither nudged nor reported", async () => {
  const card = await newCard(fleet.main, "paused");
  const worker = await idle(await begin(fleet.main, card));
  await worker.call("report", {
    status: "paused",
    text: "waiting for the API team",
    until: Date.now() + 3_600_000,
  });
  await metronome(3);
  assert.deepEqual(await findings(card), []);
  assert.equal(await status(fleet.main, card), "paused");
});

test("a card that waits on its mate is reminded in a flat bundle, one reminder each tier, until it is held for a date", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(cleo, "blocked");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "blocked", text: "the API is down" });

  await reach(cleo, card, "decisions", 3);
  const sent = await tiersOf(card, "decisions");
  assert.deepEqual(sent, inOrder(sent));
  assert.match(
    cleo.entries.at(-1)?.entry.body ?? "",
    /^reminder: 1 card needs a decision or action from you\. Give a hold an until=<date> only when the card waits on an outside event \(a quota reset, a third party, a CI run\) or the captain said later or named a date\.\nYou can settle or close these yourself\. Act on each now:\n- c-\d+ blocked \(with-mate, \d+ min\)$/,
  );

  await cleo.call("hold", { card: card.id, question: "later?", until: Date.now() + 3_600_000 });
  const stopped = (await tiersOf(card, "decisions")).length;
  await metronome(6);
  assert.equal((await tiersOf(card, "decisions")).length, stopped);
});

test("a hold that waits on main reminds main, and not the lane mate that raised it", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(cleo, "Ads stay under budget");
  await cleo.call("hold", { card: card.id, question: "Raise the budget?", options: ["No"] });

  await reach(fleet.main, card, "decisions", 1);
  const reminded = (session: Session): string[] =>
    session.entries
      .filter(({ entry }) => entry.card === card.id && entry.author === "check")
      .map(({ entry }) => String(entry.fields["condition"]));
  assert.deepEqual(reminded(fleet.main), ["decisions"]);
  assert.deepEqual(reminded(cleo), []);
});

test("a dated hold that comes back is announced at once, then reminded flat until it is dated again", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(cleo, "Ads stay under budget");
  await cleo.call("hold", { card: card.id, question: "Later?", until: Date.now() + 300 });

  const ended = await fleet.main.waitForEntry(
    (entry) => entry.card === card.id && String(entry.fields["condition"]).startsWith("hold-ended"),
    "the hold to come back",
  );
  assert.match(ended.body, /^hold ended; it waits on main again$/);
  await reach(fleet.main, card, "decisions", 2);
  const sent = await tiersOf(card, "decisions");
  assert.deepEqual(sent, inOrder(sent));

  await fleet.main.call("hold", {
    card: card.id,
    question: "wait again",
    until: Date.now() + 3_600_000,
  });
  const stopped = (await tiersOf(card, "decisions")).length;
  await metronome(6);
  assert.equal((await tiersOf(card, "decisions")).length, stopped);
});

test("a mate that is busy and then idle again is not reminded twice for the same tier", async () => {
  const card = await newCard(fleet.main, "blocked");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "blocked", text: "the API is down" });
  await reach(fleet.main, card, "decisions", 1);

  fleet.main.send({ t: "activity", state: "running" });
  await fleet.main.call("board", {});
  await metronome(2);
  fleet.main.send({ t: "activity", state: "idle" });
  await fleet.main.call("board", {});

  await reach(fleet.main, card, "decisions", 2);
  const sent = await tiersOf(card, "decisions");
  assert.deepEqual(sent, inOrder(sent));
});

test("reminders to a mate that is down wait for it, and then one reminder for the current tier arrives, not the pile", async () => {
  const token = fleet.cardd.addLane("cleo", "main");
  const cleo = await fleet.cardd.connect(token);
  const card = await newCard(cleo, "never connects");
  await begin(cleo, card);
  await reach(cleo, card, "worker-never-connected", 1);
  await cleo.close();
  const before = await tiersOf(card, "worker-never-connected");

  await metronome(4);
  assert.deepEqual(await tiersOf(card, "worker-never-connected"), before);

  const back = await fleet.cardd.connect(token);
  const first = await back.waitForEntry(
    (entry) =>
      entry.card === card.id &&
      entry.author === "check" &&
      Number(entry.fields["tier"]) > before.length,
    "a reminder after the mate returned",
  );
  assert.ok(Number(first.fields["tier"]) >= 3, `resumed at tier ${String(first.fields["tier"])}`);
  const resumed = (await tiersOf(card, "worker-never-connected")).slice(before.length);
  assert.equal(resumed.filter((tier) => tier <= Number(first.fields["tier"])).length, 1);
});

test("a finished card its mate leaves open is reminded each tier until it is closed, and main is not programmatically told", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(cleo, "Which ads convert?", "scout");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "done", text: "report written" });
  const name = `c-${String(card.id)}`;

  const reminder = await reach(cleo, card, "finished", 1);
  const report = check(CardViewSchema, await cleo.call("card", { card: card.id })).entries.find(
    (entry) => entry.kind === "report" && entry.fields["status"] === "done",
  );
  assert.ok(report !== undefined);
  assert.ok(reminder.createdAt - report.createdAt >= 7_200);
  assert.match(
    reminder.body,
    new RegExp(`^reminder: ${name} is finished and still open \\(with-mate, \\d+ min\\)\\. Relay`),
  );
  await reach(cleo, card, "finished", 2);
  await reach(cleo, card, "finished", 3);
  const sent = await tiersOf(card, "finished");
  assert.deepEqual(sent, inOrder(sent));
  assert.deepEqual(
    fleet.main.entries.filter(({ entry }) => entry.author === "check" && entry.card === card.id),
    [],
  );

  await cleo.call("close.finish", {
    card: card.id,
    mode: "done",
    text: "closed by cleo",
    archives: [],
    left: [],
  });
  assert.equal(await status(fleet.main, card), "done");
  const stopped = (await tiersOf(card, "finished")).length;
  await metronome(4);
  assert.equal((await tiersOf(card, "finished")).length, stopped);
});

test("main's own finished card is reminded each tier", async () => {
  const card = await newCard(fleet.main, "Which ads convert?", "scout");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "done", text: "report written" });

  for (const tier of [1, 2, 3, 4]) await reach(fleet.main, card, "finished", tier);
  const sent = await tiersOf(card, "finished");
  assert.deepEqual(sent, inOrder(sent));
});

test("a ship card that only did an operation is reminded how to close it", async () => {
  const card = await newCard(fleet.main, "Add credit");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  fleet.cardd.yolo("web");
  await worker.call("report", { status: "done", text: "credit added" });
  const reminder = await reach(fleet.main, card, "finished", 1);
  assert.match(
    reminder.body,
    /\(merging, \d+ min\)\. Its work may have landed from another branch\. Close it with close\(card, summary\): if close warns about commits or files not on the base branch and the work landed elsewhere, call close again with confirm=true\. If it never landed and will not, close\(card, summary=<why>, landed=false\)\.$/,
  );
});

test("a lost job is reminded to its mate each tier until the worker runs it again or drops it", async () => {
  const card = await newCard(fleet.main, "long jobs");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const start = async (label: string): Promise<number> =>
    check(OPS["job.start"].result, await worker.call("job.start", { label, command: "sleep 9" }))
      .job;
  const dropped = await start("tests");
  const rerun = await start("build");
  await reach(fleet.main, card, "job-lost-open", 2);
  const twice = fleet.main.entries.filter(
    ({ entry }) => entry.fields["condition"] === "job-lost-open",
  );
  assert.ok(twice.some(({ entry }) => entry.body.includes(`job ${String(dropped)} (tests)`)));
  assert.ok(twice.some(({ entry }) => entry.body.includes(`job ${String(rerun)} (build)`)));

  await worker.call("job.finish", { job: dropped, exitCode: 130, outputTail: "" });
  const again = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "build", command: "sleep 9" }),
  ).job;
  beats.push(
    setInterval(() => {
      worker.call("job.alive", { job: again }).catch(() => undefined);
    }, 20),
  );
  const counts = (): number =>
    fleet.main.entries.filter(({ entry }) => entry.fields["condition"] === "job-lost-open").length;
  const stopped = counts();
  await metronome(4);
  assert.equal(counts(), stopped);
});

test("a job that was marked lost while its process lives is running again on its next heartbeat", async () => {
  const card = await newCard(fleet.main, "silent but alive");
  const token = await begin(fleet.main, card);
  const worker = await fleet.cardd.connect(token);
  const { job } = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "poll", command: "lavish-axi poll" }),
  );
  await reach(fleet.main, card, "job-lost-open", 1);
  const listed = async (): Promise<number[]> =>
    check(OPS.jobs.result, await worker.call("jobs", {})).map((each) => each.id);
  assert.deepEqual(await listed(), []);

  const alive = check(OPS["job.alive"].result, await worker.call("job.alive", { job }));
  assert.equal(alive.running, true);
  assert.deepEqual(await listed(), [job]);
  const isRevival = (entry: Entry): boolean => entry.fields["revived"] === true;
  await worker.waitForEntry(isRevival, "the revival reaches the worker");
  beats.push(
    setInterval(() => {
      worker.call("job.alive", { job }).catch(() => undefined);
    }, 20),
  );
  const counts = (): number =>
    fleet.main.entries.filter(({ entry }) => entry.fields["condition"] === "job-lost-open").length;
  const before = counts();
  await metronome(4);
  assert.equal(counts(), before);
  const done = check(
    OPS["job.finish"].result,
    await worker.call("job.finish", { job, exitCode: 0, outputTail: "ok" }),
  );
  assert.equal(done.recorded, true);
});

test("a dropped lost job stays lost when its wrapper heartbeats again", async () => {
  const card = await newCard(fleet.main, "dropped then alive");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const { job } = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "poll", command: "lavish-axi poll" }),
  );
  await reach(fleet.main, card, "job-lost-open", 1);
  await worker.call("job.drop", { job });
  const alive = check(OPS["job.alive"].result, await worker.call("job.alive", { job }));
  assert.equal(alive.running, false);
  assert.deepEqual(check(OPS.jobs.result, await worker.call("jobs", {})), []);
});

test("a failed model call is repeated to the mate each tier until the worker answers again", async () => {
  const card = await newCard(fleet.main, "failing model");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("incident.report", { error: "HTTP 529 overloaded" });

  await reach(fleet.main, card, "runtime-failure-open", 3);
  const sent = await tiersOf(card, "runtime-failure-open");
  assert.deepEqual(sent, inOrder(sent));
  assert.match(
    fleet.main.entries.find(({ entry }) => entry.fields["condition"] === "runtime-failure")?.entry
      .body ?? "",
    /HTTP 529 overloaded/,
  );

  await worker.call("incident.clear", {});
  const stopped = sent.length;
  await metronome(4);
  assert.equal((await tiersOf(card, "runtime-failure-open")).length, stopped);
});

test("a repeating obligation leaves only its latest reminder for a reconnect, not a pile of unread copies", async () => {
  const token = fleet.cardd.addLane("cleo", "main");
  const cleo = await fleet.cardd.connect(token, [], false);
  const card = await newCard(cleo, "never connects");
  await begin(cleo, card);
  await reach(cleo, card, "worker-never-connected", 3);
  await cleo.close();
  const back = await fleet.cardd.connect(token);
  const latest = await reach(back, card, "worker-never-connected", 3);
  assert.equal(latest.fields["tier"], 3);
  assert.deepEqual(
    back.entries
      .filter(
        ({ entry }) =>
          entry.card === card.id && entry.fields["condition"] === "worker-never-connected",
      )
      .map(({ entry }) => entry.fields["tier"]),
    [3],
  );
});

test("legacy done reports with an explicit merge marker do not query GitHub, and close trusts them", async () => {
  fleet.cardd.yolo("web");
  const pr = "https://github.com/acme/web/pull/7";
  fleet.cardd.gh.setPr(pr, "OPEN");
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "done", text: `PR ${pr} opened`, pr });
  assert.equal(await status(fleet.main, card), "merging");
  await metronome(3);
  await worker.call("report", { status: "done", text: `merged ${pr}`, pr, merged: true });
  const plan = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: card.id }),
  );
  assert.deepEqual([plan.mode, plan.verify], ["done", false]);
  await metronome(3);

  assert.deepEqual(fleet.cardd.gh.calls(), []);
  assert.equal((await fleet.cardd.board()).cards.find((each) => each.id === card.id)?.pr, pr);
});

test("a worker that reconnects while its run_long job runs is not reported idle until the job ends", async () => {
  const busy = await newCard(fleet.main, "reconnects mid-job");
  const token = await begin(fleet.main, busy);
  const first = await fleet.cardd.connect(token);
  const [task] = await first.waitForEntries(1);
  first.ack(task?.id ?? 0);
  const { job, heartbeatMs } = check(
    OPS["job.start"].result,
    await first.call("job.start", { label: "tests", command: "npm test" }),
  );
  const beat = setInterval(() => {
    fleet.cardd.post(token, "job.alive", { job }).catch(() => undefined);
  }, heartbeatMs);
  try {
    first.send({ t: "activity", state: "waiting" });
    await first.close();
    await fleet.cardd.connect(token);

    const control = await newCard(fleet.main, "idle control");
    const controlWorker = await fleet.cardd.connect(await begin(fleet.main, control));
    const [controlTask] = await controlWorker.waitForEntries(1);
    controlWorker.ack(controlTask?.id ?? 0);
    await reach(fleet.main, control, "worker-idle", 1);
    assert.deepEqual(await tiersOf(busy, "worker-idle"), []);

    await fleet.cardd.post(token, "job.finish", { job, exitCode: 0, outputTail: "ok" });
    await reach(fleet.main, busy, "worker-idle", 1);
  } finally {
    clearInterval(beat);
  }
});

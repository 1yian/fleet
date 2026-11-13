import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  check,
  OPS,
  ownerText,
  runningText,
  waitsText,
  type BoardCard,
  type Card,
  type Pulse,
} from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { ageCard, ageSession, begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { until } from "../support/live-fleet.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let fleet: Fleet;
let cleo: Session;
beforeEach(async () => {
  fleet = await startFleet();
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
});
afterEach(async () => {
  await Promise.allSettled([cleo.close()]);
  await fleet.cardd.stop();
});

async function onBoard(card: Card): Promise<BoardCard> {
  const cards = check(OPS.board.result, await cleo.call("board", {}));
  const found = cards.find((each) => each.id === card.id);
  if (found === undefined) throw new Error(`c-${String(card.id)} is not on the board`);
  return found;
}

async function pulseWhere(card: Card, ready: (pulse: Pulse) => boolean): Promise<Pulse> {
  return until(
    async () => {
      const { pulse } = await onBoard(card);
      return pulse !== null && ready(pulse) ? pulse : undefined;
    },
    `c-${String(card.id)}'s pulse`,
  );
}

const movedBy = (ago: number) => (pulse: Pulse) => pulse.movedAt <= Date.now() - ago + MINUTE;

async function aged(title: string, ago: number): Promise<Card> {
  const card = await newCard(cleo, title);
  ageCard(fleet.cardd, card, ago);
  return card;
}

const park = (card: Card, extra: Record<string, unknown>): Promise<unknown> =>
  cleo.call("hold", {
    card: card.id,
    question: "Wait for it?",
    until: Date.now() + HOUR,
    remaining: [],
    ...extra,
  });

test("a card that runs shows who has it, what runs, and no notice, and an idle worker that just moved is quiet", async () => {
  const card = await newCard(cleo, "Ship the scrollbar fix");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  worker.send({ t: "activity", state: "running" });

  const running = await pulseWhere(card, (pulse) => pulse.state === "running");
  assert.equal(running.notice, "none");
  assert.deepEqual(running.owner, {
    kind: "worker",
    name: `c-${String(card.id)}-a1`,
    host: "maverick",
  });
  assert.equal(ownerText(running.owner), "a worker on maverick");
  assert.equal(running.waits, "nothing");
  assert.equal(runningText(await onBoard(card)), "a turn");
  assert.ok(Date.now() - running.movedAt < MINUTE, "a card that began a minute ago moved just now");

  worker.send({ t: "activity", state: "idle" });
  const quiet = await pulseWhere(card, (pulse) => pulse.state === "idle");
  assert.equal(quiet.notice, "none");
  assert.equal(runningText(await onBoard(card)), "nothing");
});

test("a running job counts as running, and is named", async () => {
  const card = await newCard(cleo, "Build the release");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  const job = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "release build", command: "make release" }),
  ).job;
  worker.send({ t: "activity", state: "waiting" });

  const pulse = await pulseWhere(card, (each) => each.state === "running");
  assert.deepEqual(pulse.running, { by: "job", what: `job ${String(job)} (release build)` });
});

test("a silent worker with a live job is running, not stalled", async () => {
  const card = await newCard(cleo, "Watch the ad campaign");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  const { job } = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "ad watch", command: "watch ads" }),
  );
  worker.send({ t: "activity", state: "running" });
  await worker.call("standing", {});
  ageSession(fleet.cardd, card, 10 * MINUTE);
  const view = await onBoard(card);
  assert.deepEqual([view.pulse?.state, view.pulse?.notice], ["running", "none"]);
  assert.equal(view.pulse?.running?.what, `job ${String(job)} (ad watch)`);
  await worker.call("job.finish", { job, exitCode: 0, outputTail: "finished" });
  const after = await onBoard(card);
  assert.deepEqual([after.pulse?.state, after.pulse?.notice], ["stalled", "captain"]);
});

test("idle is nothing running with no stated reason: main is told after 4 hours and the captain after 24", async () => {
  const young = await aged("Port the calendar", 3 * HOUR);
  const old = await aged("Port the invoices", 5 * HOUR);
  const older = await aged("Port the ads", 25 * DAY);
  const day = await aged("Port the reports", 25 * HOUR);

  const read = async (card: Card, ago: number) => pulseWhere(card, movedBy(ago));
  const states = await Promise.all([
    read(young, 3 * HOUR),
    read(old, 5 * HOUR),
    read(day, 25 * HOUR),
    read(older, 25 * DAY),
  ]);
  assert.deepEqual(
    states.map((pulse) => [pulse.state, pulse.notice]),
    [
      ["idle", "none"],
      ["idle", "main"],
      ["idle", "captain"],
      ["idle", "captain"],
    ],
  );
  assert.deepEqual(states[1].owner, { kind: "mate", name: "cleo", host: null });
  assert.equal(waitsText(await onBoard(old)), "waits on cleo");
});

test("last moved comes from entries and progress, not from the activity that a reconnect resets", async () => {
  const card = await aged("Port the invoices", 5 * HOUR);
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  worker.send({ t: "activity", state: "running" });
  worker.send({ t: "activity", state: "idle" });
  const task = await pulseWhere(card, (pulse) => pulse.owner.kind === "worker");
  assert.equal(task.state, "idle");
  assert.ok(Date.now() - task.movedAt < MINUTE, "the task comment just moved it");
  const view = (await onBoard(card)).activity;
  assert.ok(view !== null && Date.now() - view.at < MINUTE, "the session was seen just now");

  const stale = await aged("Port the ads", 5 * HOUR);
  const quiet = await fleet.cardd.connect(await begin(cleo, stale));
  quiet.send({ t: "activity", state: "idle" });
  ageCard(fleet.cardd, stale, 5 * HOUR);
  const reconnected = await pulseWhere(stale, movedBy(5 * HOUR));
  assert.equal(reconnected.state, "idle");
  assert.equal(reconnected.notice, "main", "a worker that reconnected is not a card that moved");

  quiet.send({ t: "activity", state: "running", progress: true });
  quiet.send({ t: "activity", state: "idle" });
  const progressed = await pulseWhere(stale, (pulse) => Date.now() - pulse.movedAt < MINUTE);
  assert.equal(progressed.notice, "none");
});

test("stated outside dates, declared watchers, and live jobs cover dated holds however old they are", async () => {
  const young = await newCard(cleo, "Quota card");
  await park(young, { outside: "the weekly quota resets" });
  ageCard(fleet.cardd, young, 23 * HOUR);
  const old = await newCard(cleo, "Support hub card");
  await park(old, { watcher: "the support hub log" });
  ageCard(fleet.cardd, old, 25 * HOUR);
  const urgent = await newCard(cleo, "Crud ingress card");
  await park(urgent, { outside: "the first real support hub interaction" });
  ageCard(fleet.cardd, urgent, 4 * DAY);

  const read = (card: Card, ago: number) => pulseWhere(card, movedBy(ago));
  const parked = await Promise.all([
    read(young, 23 * HOUR),
    read(old, 25 * HOUR),
    read(urgent, 4 * DAY),
  ]);
  assert.deepEqual(
    parked.map((pulse) => [pulse.state, pulse.notice, pulse.waits]),
    [
      ["waiting", "none", "date"],
      ["waiting", "none", "date"],
      ["waiting", "none", "date"],
    ],
  );
  assert.equal(waitsText(await onBoard(urgent)).startsWith("waits on an outside date"), true);
  assert.ok(Date.now() - parked[2].since >= 4 * DAY - MINUTE, "its age is the hold's age");

  const build = await newCard(cleo, "Build card");
  const worker = await fleet.cardd.connect(await begin(cleo, build));
  const job = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "release build", command: "make release" }),
  ).job;
  const beat = setInterval(() => {
    worker.call("job.alive", { job }).catch(() => undefined);
  }, 20);
  try {
    const watched = await newCard(cleo, "Watched card");
    await park(watched, { job });
    ageCard(fleet.cardd, watched, 4 * DAY);
    const waiting = await pulseWhere(watched, movedBy(4 * DAY));
    assert.deepEqual([waiting.state, waiting.notice], ["waiting", "none"]);
    assert.equal(runningText(await onBoard(watched)), `job ${String(job)} (release build)`);
  } finally {
    clearInterval(beat);
  }
});

test("a dated pause is waiting, and a decision for the captain is his to make, whatever its age", async () => {
  const card = await newCard(cleo, "Wait for the CI run");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "paused", text: "CI runs", until: Date.now() + HOUR });
  ageCard(fleet.cardd, card, 26 * HOUR);
  const paused = await pulseWhere(card, movedBy(26 * HOUR));
  assert.deepEqual([paused.state, paused.notice, paused.waits], ["waiting", "none", "pause"]);

  const asked = await aged("Merge the Wiz fix?", 5 * DAY);
  await cleo.call("hold", {
    card: asked.id,
    question: "Merge the Wiz fix?",
    options: ["Merge"],
    to: "main",
  });
  await fleet.main.call("hold", {
    card: asked.id,
    question: "Merge the Wiz fix?",
    options: ["Merge"],
    to: "captain",
  });
  const waiting = await pulseWhere(asked, (pulse) => pulse.state === "you");
  assert.deepEqual(
    [waiting.notice, waiting.owner.kind, waiting.waits, ownerText(waiting.owner)],
    ["none", "captain", "captain", "you"],
  );

  const own = check(
    OPS["card.new"].result,
    await cleo.call("card.new", { title: "Test calling in prod", kind: "captain" }),
  );
  const queued = await pulseWhere(own, (pulse) => pulse.state === "you");
  assert.equal(queued.owner.kind, "captain");
});

test("a failed worker is broken, and a blocked one is stalled only once five minutes have passed since its report", async () => {
  const failed = await newCard(cleo, "Fix the Cleo rule");
  const failing = await fleet.cardd.connect(await begin(cleo, failed));
  await failing.call("report", { status: "failed", text: "the build is red" });
  const broken = await pulseWhere(failed, (pulse) => pulse.state === "broken");
  assert.equal(broken.notice, "urgent");

  const stuck = await newCard(cleo, "Read the old invoices");
  const worker = await fleet.cardd.connect(await begin(cleo, stuck));
  await worker.call("report", { status: "blocked", text: "the run is waiting" });
  const fresh = await pulseWhere(stuck, (pulse) => pulse.owner.kind === "mate");
  assert.equal(fresh.state, "idle", "a report that is a second old is not a stall");

  ageCard(fleet.cardd, stuck, 10 * MINUTE);
  const stalled = await pulseWhere(stuck, (pulse) => pulse.state === "stalled");
  assert.equal(stalled.notice, "captain");
  assert.ok(Date.now() - stalled.since >= 10 * MINUTE - MINUTE, "it ages from the report");
});

test("a card whose worker reported failed or blocked is quiet once its mate dates it on a running schedule, and loud again when the schedule goes or the date passes", async () => {
  const schedule = check(
    OPS["schedule.set"].result,
    await cleo.call("schedule.set", {
      to: "cleo",
      at: "05:00",
      timezone: "UTC",
      text: "Check the build.",
    }),
  ).id;
  const wait = { schedule, remaining: [] };

  const blocked = await newCard(cleo, "Read the old invoices");
  const stuck = await fleet.cardd.connect(await begin(cleo, blocked));
  await stuck.call("report", { status: "blocked", text: "the run is waiting" });
  ageCard(fleet.cardd, blocked, 10 * MINUTE);
  await pulseWhere(blocked, (pulse) => pulse.state === "stalled");

  const failed = await newCard(cleo, "Fix the Cleo rule");
  const failing = await fleet.cardd.connect(await begin(cleo, failed));
  await failing.call("report", { status: "failed", text: "the build is red" });
  await pulseWhere(failed, (pulse) => pulse.state === "broken");

  await park(blocked, wait);
  await park(failed, wait);
  const quiet = await Promise.all([blocked, failed].map((card) => onBoard(card)));
  assert.deepEqual(
    quiet.map(({ pulse }) => [pulse?.state, pulse?.notice]),
    [
      ["waiting", "none"],
      ["waiting", "none"],
    ],
  );
  const [first] = quiet;
  assert.ok(first !== undefined);
  assert.equal(waitsText(first).startsWith("waits on schedule"), true);

  await cleo.call("schedule.remove", { id: schedule });
  const lost = await Promise.all(
    [blocked, failed].map((card) => pulseWhere(card, (pulse) => pulse.state === "parked")),
  );
  assert.deepEqual(
    lost.map((pulse) => pulse.notice),
    ["none", "none"],
    "a watcher that is gone is an idle park, which is not yet a day old",
  );

  const lapsing = await newCard(cleo, "Check the ads budget");
  const lapsed = await fleet.cardd.connect(await begin(cleo, lapsing));
  const own = check(
    OPS["schedule.set"].result,
    await cleo.call("schedule.set", { to: "cleo", at: "06:00", timezone: "UTC", text: "Check." }),
  ).id;
  await lapsed.call("report", { status: "failed", text: "the run failed" });
  await cleo.call("hold", {
    card: lapsing.id,
    question: "Wait for it?",
    until: Date.now() + 1_500,
    schedule: own,
    remaining: [],
  });
  assert.equal((await onBoard(lapsing)).pulse?.state, "waiting");
  const after = await pulseWhere(lapsing, (pulse) => pulse.state === "idle");
  assert.equal(after.notice, "none", "the lapsed date leaves an idle card, not a stale failure");
});

test("the steps behind a held card show how many exist and how many started", async () => {
  const held = await newCard(cleo, "Crud ingress lock");
  const queued = await newCard(cleo, "Capacity proof");
  const started = await newCard(cleo, "Caller list");
  await fleet.cardd.connect(await begin(cleo, started));
  await park(held, { outside: "the first real interaction", remaining: [queued.id, started.id] });

  const pulse = await pulseWhere(held, (each) => each.behind !== null);
  assert.deepEqual(pulse.behind, { steps: 2, started: 1 });
});

test("the steps behind a card that main holds count another lane's cards without showing whether they started or closed", async () => {
  const silas = await fleet.cardd.connect(fleet.cardd.addLane("silas", "main"));
  try {
    const waiting = await newCard(silas, "Capacity proof", "scout");
    const started = await newCard(silas, "Caller list");
    await fleet.cardd.connect(await begin(silas, started));
    const held = await newCard(cleo, "Crud ingress lock");
    await cleo.call("hold", { card: held.id, question: "Wait for it?", to: "main" });
    await fleet.main.call("hold", {
      card: held.id,
      question: "Wait for it?",
      until: Date.now() + HOUR,
      outside: "the first real interaction",
      remaining: [waiting.id, started.id],
    });

    const behindFor = async (viewer: Session): Promise<Pulse["behind"] | undefined> => {
      const board = check(OPS.board.result, await viewer.call("board", {}));
      const view = check(OPS.card.result, await viewer.call("card", { card: held.id }));
      const listed = board.find((card) => card.id === held.id)?.pulse?.behind;
      assert.deepEqual(view.card.pulse?.behind, listed, "the card and the board agree");
      return listed;
    };
    const mainSees = (steps: number, begun: number) =>
      until(
        async () => {
          const behind = await behindFor(fleet.main);
          return behind?.steps === steps && behind.started === begun ? behind : undefined;
        },
        `main to see ${String(steps)} steps, ${String(begun)} started`,
      );

    await mainSees(2, 1);
    assert.deepEqual(await behindFor(cleo), { steps: 2, started: 0 });

    await silas.call("close.finish", {
      card: waiting.id,
      mode: "done",
      text: "finished",
      next: { drop: "nothing to build" },
      archives: [],
      left: [],
    });
    await mainSees(1, 1);
    assert.deepEqual(await behindFor(cleo), { steps: 2, started: 0 });
  } finally {
    await silas.close();
  }
});

test("a closed card and a lane card have no pulse", async () => {
  const done = await newCard(cleo, "Already finished", "scout");
  await cleo.call("close.finish", {
    card: done.id,
    mode: "done",
    text: "finished",
    next: { drop: "nothing to build" },
    archives: [],
    left: [],
  });
  const cards = check(OPS.board.result, await fleet.main.call("board", {}));
  const closed = cards.find((card) => card.id === done.id);
  const lane = cards.find((card) => card.mate && card.lane === "cleo");
  assert.equal(closed?.pulse, null);
  assert.equal(lane?.pulse, null);
});

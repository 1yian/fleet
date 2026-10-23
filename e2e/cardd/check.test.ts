import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, OPS, check, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const findings = async (card: Card): Promise<string[]> =>
  check(CardViewSchema, await fleet.main.call("card", { card: card.id }))
    .entries.filter((entry) => entry.kind === "finding" && entry.author === "check")
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

test("a worker that never connects is reported to its mate, once, and the card stays Working", async () => {
  const card = await newCard(fleet.main, "never connects");
  await begin(fleet.main, card);
  await findingFor(card, "worker-never-connected");
  assert.equal(await status(fleet.main, card), "working");

  const later = await newCard(fleet.main, "a later card");
  await begin(fleet.main, later);
  await findingFor(later, "worker-never-connected");
  assert.deepEqual(await findings(card), ["worker-never-connected"]);
});

test("a worker that disconnects, and a worker that stalls, are reported to their mate and stay Working", async () => {
  const gone = await newCard(fleet.main, "disconnects");
  await (await running(await begin(fleet.main, gone))).close();
  const stuck = await newCard(fleet.main, "stalls");
  await running(await begin(fleet.main, stuck));

  await findingFor(gone, "worker-not-connected");
  await findingFor(stuck, "worker-stalled");
  assert.deepEqual(
    [await findings(gone), await findings(stuck)],
    [["worker-not-connected"], ["worker-stalled"]],
  );
  assert.deepEqual(
    [await status(fleet.main, gone), await status(fleet.main, stuck)],
    ["working", "working"],
  );
});

test("an idle worker without a handoff is reported to its mate, but a paused one waits", async () => {
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
  assert.equal(await status(fleet.main, idle), "working");
  assert.deepEqual(await findings(paused), []);
  assert.equal(await status(fleet.main, paused), "paused");
});

test("a card that waits on an idle mate gets one reminder for each tier", async () => {
  const card = await newCard(fleet.main, "blocked");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "blocked", text: "the API is down" });

  await findingFor(card, "reminder-2");
  assert.deepEqual(await findings(card), ["reminder-1", "reminder-2"]);
  assert.match(
    fleet.main.entries.at(-1)?.entry.body ?? "",
    /^reminder: this card has waited for you \(with-mate, \d+ min\)$/,
  );
});

test("a hold that waits on main reminds main, and not the lane mate that raised it", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(cleo, "Ads stay under budget");
  await cleo.call("hold", { card: card.id, question: "Raise the budget?", options: ["No"] });

  await findingFor(card, "reminder-1");
  const reminded = (session: Session): string[] =>
    session.entries
      .filter(({ entry }) => entry.card === card.id && entry.author === "check")
      .map(({ entry }) => String(entry.fields["condition"]));
  assert.deepEqual(reminded(fleet.main), ["reminder-1"]);
  assert.deepEqual(reminded(cleo), []);
});

test("a mate that is busy and then idle again is not reminded twice for the same tier", async () => {
  const card = await newCard(fleet.main, "blocked");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "blocked", text: "the API is down" });
  await findingFor(card, "reminder-1");

  fleet.main.send({ t: "activity", state: "running" });
  await fleet.main.call("board", {});
  const probe = await newCard(fleet.main, "a pass happens while the mate is busy");
  await begin(fleet.main, probe);
  await findingFor(probe, "worker-never-connected");
  fleet.main.send({ t: "activity", state: "idle" });
  await fleet.main.call("board", {});

  await findingFor(card, "reminder-2");
  assert.deepEqual(await findings(card), ["reminder-1", "reminder-2"]);
});

test("a finished card that its lane mate leaves open is reminded early, then reported to main", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(cleo, "Which ads convert?", "scout");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "done", text: "report written" });
  const name = `c-${String(card.id)}`;

  const reminder = await cleo.waitForEntry(
    (entry) => entry.fields["condition"] === "finished-1",
    "the first reminder",
  );
  assert.match(
    reminder.body,
    new RegExp(`^reminder: ${name} is finished and still open \\(with-mate, \\d+ min\\)\\. Relay`),
  );
  const escalation = await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "escalated-1",
    "the escalation to main",
  );
  assert.match(
    escalation.body,
    new RegExp(`^escalation: ${name} finished \\d+ min ago and cleo has not closed it`),
  );
  assert.deepEqual(
    fleet.main.entries
      .map(({ entry }) => String(entry.fields["condition"]))
      .filter((condition) => condition.startsWith("finished")),
    [],
  );

  await fleet.main.call("close.finish", {
    card: card.id,
    mode: "done",
    text: "closed by main",
    archives: [],
    left: [],
  });
  assert.equal(await status(fleet.main, card), "done");
});

test("main's own finished card is reminded, and never reported to anyone", async () => {
  const card = await newCard(fleet.main, "Which ads convert?", "scout");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "done", text: "report written" });

  await findingFor(card, "finished-4");
  assert.deepEqual(await findings(card), ["finished-1", "finished-2", "finished-3", "finished-4"]);
});

test("a ship card that only did an operation is reminded how to close it", async () => {
  const card = await newCard(fleet.main, "Add credit");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  fleet.cardd.yolo("web");
  await worker.call("report", { status: "done", text: "credit added" });
  const reminder = await findingFor(card, "finished-1");
  assert.match(
    reminder.body,
    /\(merging, \d+ min\)\. No PR was found for its branch: comment the worker to open one from its task branch\. If it made no code change, close it with close\(card, summary\)\. Otherwise close\(card, summary=<why>, landed=false\)\.$/,
  );
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
  const heartbeat = setInterval(() => {
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
    await findingFor(control, "worker-idle");
    assert.deepEqual(await findings(busy), []);

    await fleet.cardd.post(token, "job.finish", { job, exitCode: 0, outputTail: "ok" });
    await findingFor(busy, "worker-idle");
  } finally {
    clearInterval(heartbeat);
  }
});

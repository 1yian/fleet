import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, HttpOutcomeSchema, OPS, type Card } from "@fleet/protocol";
import { begin, newCard, park, startFleet, status, type Fleet } from "../support/fleet.ts";
import type { Session } from "../support/cardd.ts";

let fleet: Fleet;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet();
  card = await newCard(fleet.main, "Users see one scrollbar");
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const restart = async (key: string, mate = fleet.main) =>
  check(
    OPS["card.restart"].result,
    await mate.call("card.restart", { card: card.id, mode: "replace", key }),
  );

test("an ordinary restart needs no incident, names the same card and session, and a repeated key counts once", async () => {
  const token = await begin(fleet.main, card);
  await fleet.cardd.connect(token);
  const first = await restart("one");
  assert.deepEqual(
    [first.card, first.incident, first.mode, first.actor, first.role, first.repeat],
    [card.id, null, "replace", `c-${String(card.id)}-a1`, "worker", false],
  );
  const again = await restart("one");
  assert.equal(again.repeat, true);
  const notes = (await fleet.cardd.thread(card.id)).entries.filter((entry) =>
    entry.body.startsWith("Restart requested"),
  );
  assert.equal(notes.length, 1);
  assert.equal(await status(fleet.main, card), "working");
});

test("at most three ordinary restarts an hour for one card", async () => {
  await fleet.cardd.connect(await begin(fleet.main, card));
  for (const key of ["a", "b", "c"]) await restart(key);
  await assert.rejects(restart("d"), /was restarted 3 times in the last hour/);
  assert.equal((await restart("a")).repeat, true);
});

const restartFailed = async (key: string, request: number | undefined, mate = fleet.main) =>
  check(
    OPS["card.restart.failed"].result,
    await mate.call("card.restart.failed", { card: card.id, key, request }),
  );

const requestOf = (plan: { request?: number | undefined }): number => {
  assert.ok(plan.request !== undefined, "an ordinary restart that ran carries its request id");
  return plan.request;
};

test("a restart that did not run stops counting toward the hour, and its key starts it again", async () => {
  await fleet.cardd.connect(await begin(fleet.main, card));
  const requests = new Map<string, number>();
  for (const key of ["a", "b", "c"]) requests.set(key, requestOf(await restart(key)));
  await assert.rejects(restart("d"), /was restarted 3 times in the last hour/);

  assert.deepEqual(await restartFailed("b", requests.get("b")), { recorded: true });
  assert.deepEqual(await restartFailed("b", requests.get("b")), { recorded: false });
  assert.deepEqual(await restartFailed("never-asked", requests.get("a")), { recorded: false });
  assert.equal((await restart("a")).repeat, true);
  const reopened = await restart("b");
  assert.equal(reopened.repeat, false);
  await assert.rejects(restart("e"), /was restarted 3 times in the last hour/);

  const notes = (await fleet.cardd.thread(card.id)).entries.filter(
    (entry) => entry.kind === "note",
  );
  assert.equal(notes.filter((entry) => entry.body.startsWith("Restart requested")).length, 4);
  assert.deepEqual(
    notes.filter((entry) => entry.fields["restartFailed"] !== undefined).map((entry) => entry.body),
    [
      "The restart did not run, so it does not count toward the 3 an hour: its worker process could not be started.",
    ],
  );
});

test("a late report that an old request did not run cannot cancel a later request that reuses its key", async () => {
  await fleet.cardd.connect(await begin(fleet.main, card));
  const first = requestOf(await restart("k"));
  assert.deepEqual(await restartFailed("k", first), { recorded: true });
  const second = requestOf(await restart("k"));
  assert.notEqual(second, first);
  assert.deepEqual(await restartFailed("k", first), { recorded: false });
  assert.equal((await restart("k")).repeat, true);
  assert.deepEqual(await restartFailed("k", second), { recorded: true });
});

test("only the direct parent says that a restart did not run", async () => {
  await fleet.cardd.connect(await begin(fleet.main, card));
  const request = requestOf(await restart("a"));
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  await assert.rejects(restartFailed("a", request, cleo), /only the direct parent can restart/);
  assert.deepEqual(await restartFailed("a", request), { recorded: true });
});

const notice = async (request: number, mate = fleet.main) =>
  check(
    OPS["card.restart.notice"].result,
    await mate.call("card.restart.notice", { card: card.id, request }),
  );

const NOTICE = "Your session was restarted on the same card and conversation.";

test("the restart notice reaches a working card's worker, and a card that waits on its mate is neither written to nor moved to working", async () => {
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const request = requestOf(await restart("n"));
  assert.deepEqual(await notice(request), { posted: true });
  await worker.waitForEntry((entry) => entry.body.includes(NOTICE), "the restart notice");
  assert.equal(await status(fleet.main, card), "working");

  const pending = requestOf(await restart("m"));
  await worker.call("report", { status: "blocked", text: "needs a decision" });
  assert.equal(await status(fleet.main, card), "with-mate");
  const before = (await fleet.cardd.thread(card.id)).entries.length;
  assert.deepEqual(await notice(pending), { posted: false });
  assert.equal((await fleet.cardd.thread(card.id)).entries.length, before);
  assert.equal(await status(fleet.main, card), "with-mate");
});

test("the restart notice is refused for a request that is not live, and only the direct parent can ask", async () => {
  await fleet.cardd.connect(await begin(fleet.main, card));
  const request = requestOf(await restart("n"));
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  await assert.rejects(notice(request, cleo), /only the direct parent can restart/);
  assert.deepEqual(await restartFailed("n", request), { recorded: true });
  assert.deepEqual(await notice(request), { posted: false });
  assert.deepEqual(await notice(request + 1000), { posted: false });
});

test("a hold after the restart notice is queued keeps it off the worker's reconnect", async () => {
  const token = await begin(fleet.main, card);
  const worker = await fleet.cardd.connect(token);
  const { job } = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "checks", command: "npm test" }),
  );
  await worker.close();
  const request = requestOf(await restart("held"));
  assert.deepEqual(await notice(request), { posted: true });
  const { body } = await fleet.cardd.post(token, "job.finish", {
    job,
    exitCode: 0,
    outputTail: "all checks passed",
  });
  assert.deepEqual(check(HttpOutcomeSchema, body), { ok: true, value: { recorded: true } });
  await park(fleet.main, card, "wait for CI", 3_600_000);
  assert.equal((await restart("reconnect-held")).reconnect, true);

  fleet.cardd.startNewProcess(token);
  const replacement = await fleet.cardd.connect(token);
  await replacement.waitForEntry(
    (entry) => entry.kind === "job-result" && entry.body === "all checks passed",
    "the queued job result",
  );
  assert.equal(
    replacement.entries.some(({ entry }) => entry.body.includes(NOTICE)),
    false,
  );
  assert.equal(await status(fleet.main, card), "waiting");
  assert.equal(
    (await fleet.cardd.thread(card.id)).entries.filter((entry) => entry.body.includes(NOTICE))
      .length,
    1,
  );
});

test("refunding a request retires its queued notice without dropping a later request's notice or an ordinary comment", async () => {
  const token = await begin(fleet.main, card);
  await (await fleet.cardd.connect(token)).close();
  const failed = requestOf(await restart("replace"));
  assert.deepEqual(await notice(failed), { posted: true });
  assert.deepEqual(await restartFailed("replace", failed), { recorded: true });
  const next = requestOf(await restart("replace"));
  assert.deepEqual(await notice(next), { posted: true });
  const text = "Check the footer too.";
  await fleet.main.call("comment", { card: card.id, text });

  fleet.cardd.startNewProcess(token);
  const replacement = await fleet.cardd.connect(token);
  await replacement.waitForEntry((entry) => entry.body === text, "the ordinary comment");
  const sent = replacement.entries.filter(({ entry }) => entry.body.includes(NOTICE));
  assert.deepEqual(
    sent.map(({ entry }) => entry.fields["restartNotice"]),
    [next],
  );
  assert.equal(
    (await fleet.cardd.thread(card.id)).entries.filter((entry) => entry.body.includes(NOTICE))
      .length,
    2,
  );
});

test("a newer refunded restart leaves the earlier notice deliverable and frees its slot", async () => {
  const token = await begin(fleet.main, card);
  await (await fleet.cardd.connect(token)).close();
  const older = requestOf(await restart("older"));
  assert.deepEqual(await notice(older), { posted: true });
  const newer = requestOf(await restart("newer"));
  assert.deepEqual(await restartFailed("newer", newer), { recorded: true });
  const text = "Also check the footer.";
  await fleet.main.call("comment", { card: card.id, text });

  fleet.cardd.startNewProcess(token);
  const worker = await fleet.cardd.connect(token);
  await worker.waitForEntry((entry) => entry.body === text, "the comment after the queued notice");
  assert.deepEqual(
    worker.entries
      .filter(({ entry }) => entry.body.includes(NOTICE))
      .map(({ entry }) => entry.fields["restartNotice"]),
    [older],
  );
  assert.equal((await restart("older")).repeat, true);
  assert.equal((await restart("newer")).repeat, false);
  assert.equal((await restart("last-slot")).repeat, false);
  await assert.rejects(restart("over-cap"), /was restarted 3 times in the last hour/);
});

for (const delivery of ["queued", "pushed", "posted during suppression"] as const) {
  test(`refunding a successor releases the older ${delivery} notice on the same connection`, async () => {
    const token = await begin(fleet.main, card);
    const first = await fleet.cardd.connect(token, [], false);
    if (delivery !== "pushed") await first.close();
    const older = requestOf(await restart("older"));
    if (delivery !== "posted during suppression")
      assert.deepEqual(await notice(older), { posted: true });
    if (delivery === "pushed") {
      await first.waitForEntry(
        (entry) => entry.fields["restartNotice"] === older,
        "the original unread push",
      );
      await first.close();
    }
    const successor = await restart("successor");
    const newer = requestOf(successor);
    if (delivery === "posted during suppression")
      assert.deepEqual(await notice(older), { posted: true });
    const text = "Check the footer while the newer restart is pending.";
    await fleet.main.call("comment", { card: card.id, text });
    const worker = await fleet.cardd.connect(token);
    await worker.waitForEntry(
      (entry) => entry.body === text,
      "the ordinary comment after reconnect",
    );
    assert.equal(
      worker.entries.some(({ entry }) => entry.fields["restartNotice"] === older),
      false,
    );
    assert.equal((await restart("older")).generation, successor.generation);

    assert.deepEqual(await restartFailed("successor", newer), { recorded: true });
    await worker.waitForEntry(
      (entry) => entry.fields["restartNotice"] === older,
      "the restored notice without reconnecting",
    );
    assert.equal((await restart("older")).repeat, true);
    assert.equal((await restart("successor")).repeat, false);
    assert.equal((await restart("last-slot")).repeat, false);
    await assert.rejects(restart("over-cap"), /was restarted 3 times in the last hour/);
  });
}

for (const context of ["missing", "in the file", "settled"] as const) {
  test(`refunding a successor restores replay only for missing unsettled context: ${context}`, async () => {
    const token = await begin(fleet.main, card);
    const first = await fleet.cardd.connect(token, [], false, true);
    const [task] = await first.waitForEntries(1);
    assert.ok(task !== undefined);
    const older = requestOf(await restart("older"));
    assert.deepEqual(await notice(older), { posted: true });
    const original = await first.waitForEntry(
      (entry) => entry.fields["restartNotice"] === older,
      "the original notice",
    );
    first.read(original.id);
    if (context === "settled") first.ack(original.id);
    await first.call("hold.open", {});
    await first.close();

    const successor = await restart("successor");
    const before = "Check the footer while the successor is pending.";
    await fleet.main.call("comment", { card: card.id, text: before });
    const inFile = context === "in the file" ? [task.id, original.id] : [task.id];
    const worker = await fleet.cardd.connect(token, inFile, false, true);
    await worker.waitForEntry((entry) => entry.body === before, "the comment after reconnect");
    const replays = () => worker.entries.filter(({ entry }) => entry.id === original.id);
    assert.deepEqual(replays(), []);
    assert.equal((await restart("older")).generation, successor.generation);

    assert.deepEqual(await restartFailed("successor", requestOf(successor)), { recorded: true });
    await worker.call("hold.open", {});
    assert.deepEqual(
      replays().map(({ entry, again }) => [entry.body, again]),
      context === "missing" ? [[original.body, true]] : [],
    );
  });
}

test("the next replacement receives only its notice while both restart requests still count", async () => {
  const token = await begin(fleet.main, card);
  await (await fleet.cardd.connect(token)).close();
  const older = requestOf(await restart("older"));
  assert.deepEqual(await notice(older), { posted: true });
  const newer = requestOf(await restart("newer"));
  assert.deepEqual(await notice(newer), { posted: true });
  assert.deepEqual(await notice(older), { posted: false });

  fleet.cardd.startNewProcess(token);
  const worker = await fleet.cardd.connect(token);
  await worker.waitForEntry(
    (entry) => entry.fields["restartNotice"] === newer,
    "the new restart notice",
  );
  assert.deepEqual(
    worker.entries
      .filter(({ entry }) => entry.body.includes(NOTICE))
      .map(({ entry }) => entry.fields["restartNotice"]),
    [newer],
  );
  const thread = await fleet.cardd.thread(card.id);
  assert.deepEqual(
    thread.entries
      .filter((entry) => entry.body.includes(NOTICE))
      .map((entry) => entry.fields["restartNotice"]),
    [older, newer],
  );
  assert.equal((await restart("older")).repeat, true);
  assert.equal((await restart("newer")).repeat, true);
  assert.equal((await restart("last-slot")).repeat, false);
  await assert.rejects(restart("over-cap"), /was restarted 3 times in the last hour/);
});

test("incident replacement sends its recovery check, not the earlier queued restart notice", async () => {
  const token = await begin(fleet.main, card);
  const first = await fleet.cardd.connect(token);
  const { incident } = check(
    OPS["incident.report"].result,
    await first.call("incident.report", { error: "unknown model failure" }),
  );
  await first.close();
  const older = requestOf(await restart("older"));
  assert.deepEqual(await notice(older), { posted: true });
  await fleet.main.call("card.restart", {
    card: card.id,
    incident,
    generation: 1,
    mode: "replace",
    key: "recovery",
  });

  fleet.cardd.startNewProcess(token);
  const worker = await fleet.cardd.connect(token);
  await worker.waitForEntry((entry) => entry.fields["recovery"] === incident, "the recovery check");
  assert.equal(
    worker.entries.some(({ entry }) => entry.fields["restartNotice"] === older),
    false,
  );
  assert.equal((await restart("older")).repeat, true);
});

test("a pause during merging stays merging on the board and still refuses a restart", async () => {
  fleet.cardd.yolo("web");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "done", text: "ready to land" });
  const until = Date.now() + 3_600_000;
  await worker.call("report", { status: "paused", text: "deploy window", until });
  const shown = (await fleet.cardd.board()).cards.find((each) => each.id === card.id);
  if (shown === undefined) throw new Error("the card left the board");
  assert.equal(shown.status, "merging");
  assert.equal(shown.until, null);
  await assert.rejects(restart("paused-merge"), /the card is paused: restart never resumes/);
});

test("only the direct parent restarts, and a restart never resumes paused, finished, or closed work", async () => {
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  await assert.rejects(restart("x", cleo), /only the direct parent can restart/);
  await assert.rejects(
    fleet.main.call("card.restart", { card: card.id, mode: "retry", key: "r" }),
    /retry needs an incident/,
  );
  await assert.rejects(
    fleet.main.call("card.restart", { card: card.id, incident: 99, mode: "replace", key: "i" }),
    /an incident restart needs the incident's generation/,
  );
  await worker.call("report", { status: "paused", text: "waiting", until: Date.now() + 3_600_000 });
  await assert.rejects(restart("p"), /the card is paused: restart never resumes/);
  await worker.call("report", { status: "done", text: "done" });
  await assert.rejects(restart("q"), /restart never resumes paused or finished work/);
});

test("main restarts a second mate by its lane card, and nobody else restarts it", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const laneCard = (await fleet.cardd.board()).cards.find((each) => each.name === "cleo");
  assert.ok(laneCard !== undefined);
  await assert.rejects(
    fleet.main.call("card.restart", {
      card: laneCard.id,
      mode: "replace",
      key: "pin",
      model: "tier/visual",
    }),
    /model applies only when a worker's process is replaced/,
  );
  const plan = check(
    OPS["card.restart"].result,
    await fleet.main.call("card.restart", { card: laneCard.id, mode: "replace", key: "m" }),
  );
  assert.deepEqual(
    [plan.role, plan.lane, plan.incident, plan.request],
    ["mate", "cleo", null, undefined],
  );
  const entry = (await fleet.cardd.thread(laneCard.id)).entries.find(
    (note) => note.fields["restartKey"] === "m",
  );
  assert.ok(entry);
  assert.deepEqual(
    await fleet.main.call("card.restart.failed", {
      card: laneCard.id,
      key: "m",
      request: entry.id,
    }),
    { recorded: false },
  );
  const restartLane = async (key: string) =>
    check(
      OPS["card.restart"].result,
      await fleet.main.call("card.restart", { card: laneCard.id, mode: "replace", key }),
    );
  assert.equal((await restartLane("m")).repeat, true);
  for (const key of ["second", "third"]) assert.equal((await restartLane(key)).repeat, false);
  await assert.rejects(restartLane("fourth"), /was restarted 3 times in the last hour/);
  await assert.rejects(
    cleo.call("card.restart", { card: laneCard.id, mode: "replace", key: "self" }),
    /only the direct parent can restart/,
  );
});

const PR = "https://github.com/acme/web/pull/7";
const HOUR_MS = 3_600_000;

const resting: Record<string, (worker: Session, card: Card) => Promise<unknown>> = {
  paused: (worker) =>
    worker.call("report", { status: "paused", text: "wait", until: Date.now() + HOUR_MS }),
  finished: (worker) => worker.call("report", { status: "done", text: "done, no PR" }),
  "merging after the merge word": async (worker, own) => {
    await worker.call("report", { status: "done", text: "PR ready", pr: PR });
    await fleet.main.call("release", {
      card: own.id,
      words: "yes, merge it",
      source: "chat",
      choice: "Approve & merge",
    });
  },
  "waiting on the merge question": (worker) =>
    worker.call("report", { status: "done", text: "PR ready", pr: PR }),
  "waiting on a dated hold": (_worker, own) => park(fleet.main, own, "wait for CI", HOUR_MS),
};

for (const [name, rest] of Object.entries(resting)) {
  test(`a restart reconnects the disconnected worker of a card that is ${name}, resumes nothing, and what the mate sends next reaches it`, async () => {
    const token = await begin(fleet.main, card);
    const worker = await fleet.cardd.connect(token);
    await rest(worker, card);
    const before = await status(fleet.main, card);
    await assert.rejects(
      restart("while-connected"),
      /its worker is connected, so there is nothing/,
    );

    await worker.lose();
    await fleet.cardd.waitForSessionLost(`c-${String(card.id)}-a1`);
    const plan = await restart("reconnect");

    assert.deepEqual(
      [plan.actor, plan.role, plan.reconnect, plan.repeat],
      [`c-${String(card.id)}-a1`, "worker", true, false],
    );
    assert.equal(await status(fleet.main, card), before);
    const entries = (await fleet.cardd.thread(card.id)).entries;
    assert.equal(
      entries.filter((entry) => entry.fields["for"] === "worker").length,
      0,
      "the restart sent the worker nothing",
    );
    assert.equal((await restart("reconnect")).repeat, true);

    const returned = await fleet.cardd.connect(token);
    await fleet.main.call("comment", { card: card.id, text: "Carry on." });
    const heard = await returned.waitForEntry((entry) => entry.body === "Carry on.", "the comment");
    assert.equal(heard.card, card.id);
    await returned.close();
  });
}

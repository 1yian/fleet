import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

const WEB_CLONES_REFRESHED_AFTER_A_SHIP_CLOSE = [
  { project: "web", host: "maverick", path: "/clones/web", base: "main" },
  { project: "web", host: "p620", path: "/clones/web", base: "main" },
];

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet();
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const notLanded = (card: number, why: string) => ({
  message: `c-${String(card)} did not land: ${why}. To end it anyway, call close(card, summary=<why it is dropped>, landed=false). That marks it Dropped and archives its work.`,
});

test("close refuses Done for work whose worker has not reported done, and landed=false drops it", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await begin(fleet.main, card);
  await assert.rejects(
    fleet.main.call("close.begin", { card: card.id }),
    notLanded(card.id, "the worker has not reported done"),
  );
  await assert.rejects(
    fleet.main.call("close.begin", { card: card.id, landed: true }),
    notLanded(card.id, "the worker has not reported done"),
  );

  assert.deepEqual(await fleet.main.call("close.begin", { card: card.id, landed: false }), {
    mode: "dropped",
    verify: false,
    land: false,
    attempts: [
      {
        session: `c-${String(card.id)}-a1`,
        host: "maverick",
        branch: `c-${String(card.id)}-a1`,
        base: "main",
        clone: "/clones/web",
        live: true,
      },
    ],
    refresh: WEB_CLONES_REFRESHED_AFTER_A_SHIP_CLOSE,
  });
  await fleet.main.call("close.finish", {
    card: card.id,
    mode: "dropped",
    text: "the design changed",
    archives: [],
    left: [],
  });
  assert.equal(await status(fleet.main, card), "dropped");
});

test("close.begin lists every attempt of the card, including a replaced one", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await begin(fleet.main, card);
  await fleet.main.call("attempt.begin", {
    card: card.id,
    host: "p620",
    task: "again",
    replace: true,
  });
  const name = (n: number): string => `c-${String(card.id)}-a${String(n)}`;
  assert.deepEqual(await fleet.main.call("close.begin", { card: card.id, landed: false }), {
    mode: "dropped",
    verify: false,
    land: false,
    attempts: [
      {
        session: name(1),
        host: "maverick",
        branch: name(1),
        base: "main",
        clone: "/clones/web",
        live: false,
      },
      {
        session: name(2),
        host: "p620",
        branch: name(2),
        base: "main",
        clone: "/clones/web",
        live: true,
      },
    ],
    refresh: WEB_CLONES_REFRESHED_AFTER_A_SHIP_CLOSE,
  });
});

test("close waits while a hold is open, for Done and for Dropped", async () => {
  const card = await newCard(fleet.main, "Pick the API version", "captain");
  await fleet.main.call("hold", { card: card.id, question: "v1 or v2?", options: ["v1", "v2"] });
  const held = {
    message: `c-${String(card.id)} has an open hold; clear it first with hold(card, clear=true), with the captain's words when it waits on him`,
  };
  await assert.rejects(fleet.main.call("close.begin", { card: card.id }), held);
  await assert.rejects(fleet.main.call("close.begin", { card: card.id, landed: false }), held);
});

test("a ship card that no worker ran does not close as Done", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await assert.rejects(
    fleet.main.call("close.begin", { card: card.id }),
    notLanded(card.id, "no worker ran it"),
  );
  const decision = await newCard(fleet.main, "Pick the API version", "captain");
  const plan = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: decision.id }),
  );
  assert.deepEqual([plan.mode, plan.verify], ["done", false]);
});

test("a second mate's finished card reaches main with its summary, and its worker loses access", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(cleo, "Which ads convert?", "scout");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "done", text: "report written" });
  await cleo.call("close.finish", {
    card: card.id,
    mode: "done",
    text: "Search ads convert best.",
    archives: [],
    left: [],
  });

  assert.equal(await status(cleo, card), "done");
  const outcome = await fleet.main.waitForEntry((entry) => entry.kind === "cleanup", "the outcome");
  assert.deepEqual([outcome.body, outcome.fields["outcome"]], ["Search ads convert best.", "done"]);
  await assert.rejects(worker.call("report", { status: "note", text: "late" }), {
    message: "the connection closed with 4001",
  });
  await assert.rejects(cleo.call("close.begin", { card: card.id }), {
    message: `c-${String(card.id)} is already done`,
  });
});

test("when main closes a second mate's card, that mate hears of it and main does not", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(cleo, "Which ads convert?", "scout");
  const text = "The captain dropped it.";
  await fleet.main.call("close.finish", {
    card: card.id,
    mode: "dropped",
    text,
    archives: [],
    left: [],
  });

  const outcome = await cleo.waitForEntry((entry) => entry.kind === "cleanup", "the outcome");
  assert.deepEqual([outcome.author, outcome.body], ["mate:main", text]);
  await fleet.main.call("board", {});
  assert.deepEqual(
    fleet.main.entries.filter((push) => push.entry.kind === "cleanup"),
    [],
  );
});

test("a ship card that only did an operation closes as Done, as c-9 did", async () => {
  const leo = await fleet.cardd.connect(fleet.cardd.addLane("leo", "main"));
  fleet.cardd.yolo("web");
  const card = await newCard(leo, "Add $10 of credit to the captain's account");
  const worker = await fleet.cardd.connect(await begin(leo, card));
  await worker.call("report", { status: "done", text: "credit added, no code change" });
  const name = `c-${String(card.id)}`;

  const plan = await leo.call("close.begin", { card: card.id });
  assert.deepEqual(plan, {
    mode: "done",
    verify: true,
    land: false,
    attempts: [
      {
        session: `${name}-a1`,
        host: "maverick",
        branch: `${name}-a1`,
        base: "main",
        clone: "/clones/web",
        live: true,
      },
    ],
    refresh: WEB_CLONES_REFRESHED_AFTER_A_SHIP_CLOSE,
  });
  await leo.call("close.finish", {
    card: card.id,
    mode: "done",
    text: "Added $10 of credit. No code change.",
    archives: [],
    left: [],
  });

  assert.equal(await status(leo, card), "done");
  const outcome = await fleet.main.waitForEntry((entry) => entry.kind === "cleanup", "the outcome");
  assert.equal(outcome.fields["outcome"], "done");
});

test("close needs the worker's latest handoff to be done, and a steer takes it back", async () => {
  fleet.cardd.yolo("web");
  const card = await newCard(fleet.main, "Add credit", "ship");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const close = { card: card.id };
  const unfinished = notLanded(card.id, "the worker has not reported done");

  await worker.call("report", { status: "failed", text: "the dashboard is down" });
  await assert.rejects(fleet.main.call("close.begin", close), unfinished);
  await worker.call("report", { status: "done", text: "credit added" });
  assert.equal((await fleet.main.call("close.begin", close)) !== undefined, true);

  await fleet.main.call("comment", { card: card.id, text: "also check the invoice" });
  await assert.rejects(fleet.main.call("close.begin", close), unfinished);
  await worker.call("report", { status: "done", text: "invoice checked" });
  assert.equal((await fleet.main.call("close.begin", close)) !== undefined, true);
});

test("a scout closes as Done once its worker reported done, with nothing for the host to confirm, and refreshes no clone", async () => {
  const card = await newCard(fleet.main, "Which ads convert?", "scout");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "done", text: "report written" });
  const plan = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: card.id }),
  );
  assert.deepEqual([plan.mode, plan.verify], ["done", false]);
  assert.deepEqual(plan.refresh, []);
});

test("a delivered scout keeps its completion across coordination comments, replies, holds, and a cardd restart", async () => {
  const token = fleet.cardd.addLane("cnp", "main");
  const cnp = await fleet.cardd.connect(token);
  const card = await newCard(cnp, "Assess the lifecycle", "scout");
  const worker = await fleet.cardd.connect(await begin(cnp, card));
  await worker.call("report", { status: "done", text: "assessment delivered, no project changes" });
  await fleet.main.call("comment", {
    card: card.id,
    text: "Implementation belongs to other cards.",
    reply: true,
  });
  const request = await cnp.waitForEntry(
    (entry) => entry.body === "Implementation belongs to other cards.",
    "main's coordination",
  );
  const done = { card: card.id };
  assert.equal((await cnp.call("close.begin", done)) !== undefined, true);
  await cnp.call("comment", {
    card: card.id,
    text: "The assessment is delivered.",
    replyTo: `r-${String(request.id)}`,
  });
  assert.equal((await cnp.call("close.begin", done)) !== undefined, true);
  assert.equal(
    await fleet.cardd.act(card.id, { kind: "comment", text: "Relay the findings." }),
    200,
  );
  const captain = (await fleet.cardd.thread(card.id)).entries.findLast(
    (entry) => entry.author === "captain",
  );
  assert.ok(captain !== undefined);
  await fleet.main.call("comment", {
    card: card.id,
    text: "Findings relayed.",
    replyTo: `r-${String(captain.id)}`,
  });
  await cnp.call("hold", { card: card.id, question: "Review the assessment?" });
  await assert.rejects(cnp.call("close.begin", done), /has an open hold/);
  await cnp.call("release", { card: card.id, note: "Reviewed; implementation is separate." });
  await fleet.cardd.restart();
  const resumed = await fleet.cardd.connect(token);
  const plan = check(OPS["close.begin"].result, await resumed.call("close.begin", done));
  assert.equal(plan.mode, "done");
  await resumed.call("close.finish", {
    card: card.id,
    mode: "done",
    text: "Assessment delivered.",
    archives: [],
    left: [],
  });
  assert.equal(await status(resumed, card), "done");
});

test("new worker input, a replacement attempt, and incomplete handoffs still prevent normal close", async () => {
  const card = await newCard(fleet.main, "Assess the lifecycle", "scout");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const done = { card: card.id };
  const unfinished = notLanded(card.id, "the worker has not reported done");
  await worker.call("report", { status: "done", text: "assessment delivered" });
  await fleet.main.call("comment", { card: card.id, text: "Check the missing evidence." });
  await assert.rejects(fleet.main.call("close.begin", done), unfinished);
  await worker.call("report", { status: "done", text: "evidence checked" });
  const replacement = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", {
      card: card.id,
      host: "maverick",
      task: "Reassess the lifecycle",
      replace: true,
    }),
  );
  await assert.rejects(fleet.main.call("close.begin", done), unfinished);
  const current = await fleet.cardd.connect(replacement.token);
  for (const state of ["in-review", "blocked", "failed", "stopped"] as const) {
    await current.call("report", { status: "done", text: "assessment delivered" });
    await current.call("report", { status: state, text: "not complete" });
    await assert.rejects(fleet.main.call("close.begin", done), unfinished);
  }
  assert.equal(await status(fleet.main, card), "with-mate");
});

test("dispatch refuses a captain card", async () => {
  const card = await newCard(fleet.main, "Pick the API version", "captain");
  await assert.rejects(begin(fleet.main, card), {
    message: `c-${String(card.id)} is a captain card: it is for the captain alone, so no worker runs it`,
  });
});

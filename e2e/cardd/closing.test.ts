import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

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

test("a scout closes as Done once its worker reported done, with nothing for the host to confirm", async () => {
  const card = await newCard(fleet.main, "Which ads convert?", "scout");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "done", text: "report written" });
  const plan = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: card.id }),
  );
  assert.deepEqual([plan.mode, plan.verify], ["done", false]);
});

test("dispatch refuses a captain card", async () => {
  const card = await newCard(fleet.main, "Pick the API version", "captain");
  await assert.rejects(begin(fleet.main, card), {
    message: `c-${String(card.id)} is a captain card: it is for the captain alone, so no worker runs it`,
  });
});

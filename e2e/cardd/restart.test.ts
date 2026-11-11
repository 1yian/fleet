import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card } from "@fleet/protocol";
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
  assert.deepEqual([plan.role, plan.lane, plan.incident], ["mate", "cleo", null]);
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

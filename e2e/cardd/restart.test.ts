import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card } from "@fleet/protocol";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

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

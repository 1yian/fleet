// cleanup and card drop guards and outcomes (spec sections 7.4, 10.5, and 20.5),
// against a real cardd. The host steps are in e2e/extension/dispatch.test.ts.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet();
});
afterEach(async () => {
  await fleet.cardd.stop();
});

test("cleanup refuses unlanded ship work, and card_drop takes it", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await begin(fleet.main, card);
  await assert.rejects(fleet.main.call("close.begin", { card: card.id, mode: "done" }), {
    message: `c-${String(card.id)} has not landed; cleanup is for merged or delivered work. Use card_drop.`,
  });

  assert.deepEqual(await fleet.main.call("close.begin", { card: card.id, mode: "dropped" }), {
    attempts: [
      {
        session: `c-${String(card.id)}-a1`,
        host: "maverick",
        branch: `c-${String(card.id)}-a1`,
        base: "main",
        clone: "/clones/web",
      },
    ],
  });
  await fleet.main.call("close.finish", {
    card: card.id,
    mode: "dropped",
    text: "the design changed",
    archives: [],
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
  assert.deepEqual(await fleet.main.call("close.begin", { card: card.id, mode: "dropped" }), {
    attempts: [
      { session: name(1), host: "maverick", branch: name(1), base: "main", clone: "/clones/web" },
      { session: name(2), host: "p620", branch: name(2), base: "main", clone: "/clones/web" },
    ],
  });
});

test("cleanup and drop wait while a question is open", async () => {
  const card = await newCard(fleet.main, "Pick the API version", "captain");
  await fleet.main.call("ask", { card: card.id, question: "v1 or v2?", options: ["v1", "v2"] });
  await assert.rejects(fleet.main.call("close.begin", { card: card.id, mode: "dropped" }), {
    message: `c-${String(card.id)} has an open question; the captain answers it, or agrees that it is moot, first`,
  });
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
  });

  assert.equal(await status(cleo, card), "done");
  const outcome = await fleet.main.waitForEntry((entry) => entry.kind === "cleanup", "the outcome");
  assert.deepEqual([outcome.body, outcome.fields["outcome"]], ["Search ads convert best.", "done"]);
  await assert.rejects(worker.call("report", { status: "note", text: "late" }), {
    message: "the connection closed with 4001",
  });
  await assert.rejects(cleo.call("close.begin", { card: card.id, mode: "done" }), {
    message: `c-${String(card.id)} is already done`,
  });
});

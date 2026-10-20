// Card status transitions, guards, and who receives reports (spec sections 7 and 10).
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Card } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
let card: Card;
let worker: Session;
beforeEach(async () => {
  fleet = await startFleet();
  card = await newCard(fleet.main, "Users see one scrollbar");
  worker = await fleet.cardd.connect(await begin(fleet.main, card));
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const report = (state: string, text: string, key?: string): Promise<unknown> =>
  worker.call("report", key === undefined ? { status: state, text } : { status: state, text, key });
const comment = (text: string, resolves?: string): Promise<unknown> =>
  fleet.main.call(
    "comment",
    resolves === undefined ? { card: card.id, text } : { card: card.id, text, resolves },
  );

test("a card waits with the mate until its last open decision is answered", async () => {
  assert.equal(await status(fleet.main, card), "working");
  await report("needs-decision", "which table?", "table");
  await report("needs-decision", "which index?", "index");
  assert.equal(await status(fleet.main, card), "with-mate");

  await comment("use cards", "table");
  assert.equal(await status(fleet.main, card), "with-mate");
  await comment("no index", "index");
  assert.equal(await status(fleet.main, card), "working");
});

test("a comment returns the card to In review while the pipeline runs", async () => {
  await report("in-review", "no-mistakes started");
  assert.equal(await status(fleet.main, card), "in-review");
  await report("blocked", "the review asks about the API");
  assert.equal(await status(fleet.main, card), "with-mate");
  await comment("keep the old API");
  assert.equal(await status(fleet.main, card), "in-review");
  await report("done", "PR green and ready");
  assert.equal(await status(fleet.main, card), "needs-you");
});

test("routine reports stay on the board, except the first one after the task or a comment", async () => {
  await report("working", "reading the code");
  await comment("use the v2 endpoint");
  await report("working", "switched to v2");
  await report("note", "v2 is slower");
  await report("blocked", "v2 is down");
  await fleet.main.call("board", {});

  assert.deepEqual(
    fleet.main.entries.map(({ entry }) => [entry.fields["status"], entry.body]),
    [
      ["working", "reading the code"],
      ["working", "switched to v2"],
      ["blocked", "v2 is down"],
    ],
  );
});

test("a second mate's worker reports to that mate, not to main", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const cleoCard = await newCard(cleo, "Ads stay under budget", "scout");
  const cleoWorker = await fleet.cardd.connect(await begin(cleo, cleoCard));
  await cleoWorker.call("report", { status: "done", text: "report written" });
  await cleo.call("board", {});
  await fleet.main.call("board", {});

  assert.deepEqual(
    cleo.entries.map(({ entry }) => [entry.card, entry.body]),
    [[cleoCard.id, "report written"]],
  );
  assert.deepEqual(fleet.main.entries, []);
  assert.equal(await status(cleo, cleoCard), "with-mate");
});

test("sessions call only the operations of their role and lane", async () => {
  await assert.rejects(worker.call("card.new", { title: "x", kind: "ship" }), {
    message: "worker sessions cannot call card.new",
  });
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  await assert.rejects(cleo.call("comment", { card: card.id, text: "hi" }), {
    message: `c-${String(card.id)} belongs to lane main`,
  });
  await assert.rejects(fleet.main.call("report", { status: "working", text: "x" }), {
    message: "mate sessions cannot call report",
  });
});

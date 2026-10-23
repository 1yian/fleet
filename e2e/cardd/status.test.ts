import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BoardSchema, check, type Card, type BoardCard } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";

const PR = "https://github.com/acme/web/pull/21";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

async function onBoard(card: Card): Promise<BoardCard> {
  const board = check(BoardSchema, await fleet.cardd.board());
  const found = board.cards.find((each) => each.id === card.id);
  if (found === undefined) throw new Error(`c-${String(card.id)} is not on the board`);
  return found;
}

async function settled(card: Card, ready: (card: BoardCard) => boolean): Promise<BoardCard> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = await onBoard(card);
    if (ready(found)) return found;
    if (Date.now() > deadline) throw new Error(`c-${String(card.id)} stayed ${found.status}`);
    await fleet.main.call("board", {});
  }
}

async function working(title: string): Promise<{ card: Card; worker: Session }> {
  const card = await newCard(fleet.main, title);
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  return { card, worker };
}

test("a paused report shows the card as paused with its time, and the next working report ends it", async () => {
  const { card, worker } = await working("waits for CI");
  const until = Date.now() + 3_600_000;
  assert.equal((await onBoard(card)).status, "working");

  await worker.call("report", { status: "paused", text: "CI runs until the hour", until });
  const paused = await onBoard(card);
  assert.deepEqual([paused.status, paused.pausedUntil, paused.attention], ["paused", until, null]);

  await worker.call("report", { status: "working", text: "CI is green" });
  const resumed = await onBoard(card);
  assert.deepEqual([resumed.status, resumed.pausedUntil], ["working", null]);
});

test("a paused report whose time has passed shows the card as working again", async () => {
  const { card, worker } = await working("short pause");
  await worker.call("report", { status: "paused", text: "a moment", until: Date.now() + 300 });
  assert.equal((await onBoard(card)).status, "paused");
  const resumed = await settled(card, (each) => each.status === "working");
  assert.equal(resumed.pausedUntil, null);
});

test("blocked, failed, and stopped reports show red attention, and a working report clears it", async () => {
  for (const reported of ["blocked", "failed", "stopped"] as const) {
    const { card, worker } = await working(`goes ${reported}`);
    await worker.call("report", { status: reported, text: `the work is ${reported}` });
    const red = await onBoard(card);
    assert.deepEqual([red.status, red.attention], ["with-mate", reported]);

    if (reported === "failed") continue;
    await worker.call("report", { status: "working", text: "back at it" });
    const clear = await onBoard(card);
    assert.deepEqual([clear.status, clear.attention], ["working", null]);
  }
});

test("a note report changes nothing, and the last report decides", async () => {
  const { card, worker } = await working("notes");
  await worker.call("report", { status: "blocked", text: "the API is down" });
  await worker.call("report", { status: "note", text: "still looking" });
  assert.equal((await onBoard(card)).attention, "blocked");
  await worker.call("report", { status: "in-review", text: "the pipeline runs" });
  const review = await onBoard(card);
  assert.deepEqual([review.status, review.attention], ["in-review", null]);
});

test("an open hold wins over the last report, and the card goes to its mate when the captain answers", async () => {
  const { card, worker } = await working("held");
  await fleet.main.call("hold", { card: card.id, question: "Ship it to the store?" });
  assert.equal((await onBoard(card)).status, "needs-you");

  await worker.call("report", { status: "blocked", text: "the API is down" });
  const held = await onBoard(card);
  assert.deepEqual([held.status, held.attention, held.holder], ["needs-you", null, "captain"]);
  await worker.call("report", {
    status: "paused",
    text: "waiting",
    until: Date.now() + 3_600_000,
  });
  assert.equal((await onBoard(card)).status, "needs-you");

  await fleet.main.call("release", {
    card: card.id,
    words: "ship it",
    source: "chat",
  });
  const answered = await onBoard(card);
  assert.deepEqual([answered.holder, answered.status], [null, "with-mate"]);
  await worker.call("report", { status: "working", text: "shipping" });
  assert.equal((await onBoard(card)).status, "working");
});

test("a timed-check finding leaves the status as the reports say", async () => {
  const { card, worker } = await working("PR work");
  fleet.cardd.yolo("web");
  await worker.call("report", { status: "done", text: "PR green and ready", pr: PR });
  assert.equal((await onBoard(card)).status, "merging");

  const silent = await newCard(fleet.main, "never connects");
  await begin(fleet.main, silent);
  await fleet.main.waitForEntry(
    (entry) => entry.card === silent.id && entry.fields["condition"] === "worker-never-connected",
    "never connected",
  );
  assert.equal((await onBoard(silent)).status, "working");
});

test("a card is Done after its mate closes it, whatever its reports said", async () => {
  const card = await newCard(fleet.main, "a scout", "scout");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "done", text: "report written" });
  assert.equal((await onBoard(card)).status, "with-mate");
  await fleet.main.call("close.finish", {
    card: card.id,
    mode: "done",
    text: "relayed",
    archives: [],
    left: [],
  });
  assert.equal((await onBoard(card)).status, "done");
});

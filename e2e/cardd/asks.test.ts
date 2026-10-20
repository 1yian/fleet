// Asks, answers, hand-backs, and holds (spec sections 7, 13, and 17), against
// a real cardd whose timers run a thousand times faster.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Card, Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
let cleo: Session;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  card = await newCard(cleo, "Ads stay under budget", "scout");
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const ask = (from: Session, question = "Raise the daily budget?") =>
  from.call("ask", { card: card.id, question, options: ["yes", "no"] });
const seen = (session: Session): [string, string, string][] =>
  session.entries.map(({ entry }: { entry: Entry }) => [entry.kind, entry.author, entry.body]);

test("a second mate's question goes to main first, and main forwards it to the captain", async () => {
  await ask(cleo);
  assert.equal(await status(fleet.main, card), "with-first-mate");
  await fleet.main.waitForEntries(1);
  assert.deepEqual(seen(fleet.main), [["ask", "mate:cleo", "Raise the daily budget?"]]);

  await ask(fleet.main, "Cleo asks to raise the daily budget. I recommend no.");
  assert.equal(await status(fleet.main, card), "needs-you");
  await fleet.main.call("answer", { card: card.id, words: "no, keep it", source: "chat" });
  assert.equal(await status(fleet.main, card), "with-mate");
  await cleo.waitForEntries(1);
  assert.deepEqual(seen(cleo), [["answer", "captain", "no, keep it"]]);
});

test("main hands a question back, and the question closes", async () => {
  await ask(cleo);
  await fleet.main.call("handback", {
    card: card.id,
    guidance: "Your grant covers this. Decide it.",
  });

  assert.equal(await status(fleet.main, card), "with-mate");
  await cleo.waitForEntries(1);
  assert.deepEqual(seen(cleo), [["note", "mate:main", "Your grant covers this. Decide it."]]);
  await assert.rejects(fleet.main.call("answer", { card: card.id, words: "x", source: "chat" }), {
    message: `c-${String(card.id)} has no open question`,
  });
});

test("an answer from the record must quote words the captain wrote", async () => {
  const other = await newCard(fleet.main, "Pick the API version");
  await fleet.main.call("ask", { card: other.id, question: "v1 or v2?", options: ["v1", "v2"] });
  await fleet.main.call("answer", {
    card: other.id,
    words: "Always use v2 for new work.",
    source: "chat",
  });
  await ask(cleo, "Which API version?");

  await assert.rejects(
    fleet.main.call("answer", { card: card.id, words: "use v3", source: "record" }),
    {
      message:
        "these words are not in the captain's messages or board entries; quote the captain exactly",
    },
  );
  await fleet.main.call("answer", {
    card: card.id,
    words: "Always use v2 for new work.",
    source: "record",
  });
  assert.equal(await status(fleet.main, card), "with-mate");
});

test("a question that main does not take goes to the captain", async () => {
  await ask(cleo);
  await cleo.waitForEntry((entry) => entry.fields["condition"] === "first-mate", "the forward");
  assert.equal(await status(cleo, card), "needs-you");
  assert.equal(
    cleo.entries.at(-1)?.entry.body,
    "forwarded to the captain: main did not take the question within 15 minutes",
  );
});

test("while a question is open, worker reports do not take the card from the captain", async () => {
  const own = await newCard(fleet.main, "Users see one scrollbar");
  const worker = await fleet.cardd.connect(await begin(fleet.main, own));
  await fleet.main.call("ask", {
    card: own.id,
    question: "Ship on Friday?",
    options: ["yes", "no"],
  });
  await worker.call("report", { status: "blocked", text: "waiting for the answer" });
  assert.equal(await status(fleet.main, own), "needs-you");
});

test("a hold ends on its date, and the card returns to its status", async () => {
  const held = await newCard(fleet.main, "Renew the certificate");
  await fleet.main.call("hold", {
    card: held.id,
    until: Date.now() + 300,
    reason: "after the freeze",
  });
  assert.equal(await status(fleet.main, held), "waiting");

  await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "hold-ended",
    "the hold to end",
  );
  assert.equal(await status(fleet.main, held), "queued");
});

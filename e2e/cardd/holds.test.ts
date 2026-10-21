// Holds (spec sections 7 and 17), against a real cardd with a scratch database and
// scratch lanes: one hold per card, who it waits on, how it is released and held again,
// and what the captain's board shows of it.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { MERGE_OPTIONS, type Board, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

const PR = "https://github.com/acme/web/pull/7";

let fleet: Fleet;
let cleo: Session;
beforeEach(async () => {
  fleet = await startFleet();
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
});
afterEach(async () => {
  await fleet.cardd.stop();
});

/** A card of the lane mate with a worker on it. */
async function laneCard(title = "Ads stay under budget"): Promise<{ card: Card; worker: Session }> {
  const card = await newCard(cleo, title);
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  return { card, worker };
}

const entries = async (card: Card): Promise<Entry[]> => (await fleet.cardd.thread(card.id)).entries;
const kinds = (session: Session): string[] => session.entries.map(({ entry }) => entry.kind);
/** The one hold that waits on the captain. */
async function theHold(): Promise<Board["holds"][number]> {
  const { holds } = await fleet.cardd.board();
  const [only, ...more] = holds;
  if (only === undefined || more.length > 0)
    throw new Error(`expected one hold, got ${String(holds.length)}`);
  return only;
}
const needsYou = async (): Promise<number[]> =>
  (await fleet.cardd.board()).holds.map((hold) => hold.card);
const ask = (card: Card, extra: Record<string, unknown> = {}) => ({
  card: card.id,
  question: "Raise the daily budget?",
  options: ["No", "Yes"],
  ...extra,
});

test("a worker's decision is its mate's to resolve: it never reaches the captain or main", async () => {
  const { card, worker } = await laneCard();
  await worker.call("report", { status: "needs-decision", key: "api", text: "v1 or v2?" });

  assert.equal(await status(cleo, card), "with-mate");
  assert.deepEqual(await needsYou(), []);
  await cleo.waitForEntry((entry) => entry.kind === "report", "the worker's decision");

  await cleo.call("comment", { card: card.id, text: "Use v2.", resolves: "api" });
  assert.equal(await status(cleo, card), "working");
  assert.deepEqual(await needsYou(), []);
  assert.deepEqual(kinds(fleet.main), []);
  // The mate's decision is on the thread that the captain reads.
  const decided = (await entries(card)).find((entry) => entry.fields["resolves"] === "api");
  assert.deepEqual([decided?.author, decided?.body], ["mate:cleo", "Use v2."]);
});

test("a worker's decision that climbs to the captain is answered by him, and the mate then answers the worker", async () => {
  const { card, worker } = await laneCard();
  await worker.call("report", { status: "needs-decision", key: "api", text: "v1 or v2?" });
  await cleo.call(
    "hold",
    ask(card, { question: "Worker asks: v1 or v2? I recommend v2.", options: ["v2", "v1"] }),
  );
  await fleet.main.call("hold", ask(card, { to: "captain", options: ["v2", "v1"] }));
  assert.deepEqual(await needsYou(), [card.id]);

  // The captain holds it: the mate cannot answer the worker around him.
  await assert.rejects(cleo.call("comment", { card: card.id, text: "Use v2.", resolves: "api" }), {
    message: /the captain holds c-\d+: clear the hold with his exact words/,
  });
  const open = await theHold();
  assert.equal(
    await fleet.cardd.act(card.id, { kind: "answer", hold: open.hold, choice: "v2" }),
    200,
  );
  assert.equal(await status(cleo, card), "with-mate");
  await cleo.call("comment", { card: card.id, text: "The captain chose v2.", resolves: "api" });
  assert.equal(await status(cleo, card), "working");

  // The worker's next gate is the same card's hold again, with its mate first.
  await worker.call("report", { status: "needs-decision", key: "db", text: "sqlite or postgres?" });
  assert.equal(await status(cleo, card), "with-mate");
  assert.deepEqual(await needsYou(), []);
  const next = (await entries(card)).filter((entry) => entry.kind === "report").at(-1);
  assert.equal(next?.fields["key"], "db");
});

test("a lane hold climbs one level at a time and shows once in Needs you, when main escalates it", async () => {
  const { card } = await laneCard();
  const fresh = await newCard(cleo, "Fresh card");
  await assert.rejects(cleo.call("hold", ask(fresh, { to: "captain" })), {
    message: /escalate it one level at a time/,
  });
  await assert.rejects(fleet.main.call("hold", ask(card, { to: "captain" })), {
    message: /has no hold with main/,
  });

  await cleo.call("hold", ask(card));
  assert.equal(await status(cleo, card), "with-mate");
  assert.deepEqual(await needsYou(), []);
  const forwarded = await fleet.main.waitForEntry((entry) => entry.kind === "hold", "the hold");
  assert.equal(forwarded.author, "mate:cleo");
  assert.equal(
    (await fleet.cardd.board()).cards.find((each) => each.id === card.id)?.holder,
    "main",
  );

  // The same hold again is the same hold: nothing is written.
  const before = (await entries(card)).length;
  await cleo.call("hold", ask(card));
  assert.equal((await entries(card)).length, before);
  await assert.rejects(cleo.call("hold", ask(card, { to: "captain" })), {
    message: /only main marks a hold as the captain's/,
  });

  await fleet.main.call(
    "hold",
    ask(card, { to: "captain", question: "Cleo asks to raise the budget. I recommend no." }),
  );
  assert.equal(await status(cleo, card), "needs-you");
  const { holds } = await fleet.cardd.board();
  assert.equal(holds.length, 1);
  assert.equal(holds[0]?.question, "Cleo asks to raise the budget. I recommend no.");
  await cleo.waitForEntry((entry) => entry.author === "mate:main", "main's escalation");
  const held = (await entries(card)).filter((entry) => entry.kind === "hold");
  assert.deepEqual(
    held.map((entry) => entry.fields["occurrence"]),
    [1, 1],
  );
});

test("the captain's answer releases the whole hold, and the card moves on", async () => {
  const { card } = await laneCard();
  await cleo.call("hold", ask(card));
  await fleet.main.call("hold", ask(card, { to: "captain" }));
  const open = await theHold();

  assert.equal(
    await fleet.cardd.act(card.id, { kind: "answer", hold: open.hold, choice: "No" }),
    200,
  );
  assert.equal(await status(cleo, card), "with-mate");
  assert.deepEqual(await needsYou(), []);
  const heard = await cleo.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.equal(heard.body, "No");
  await fleet.main.waitForEntry((entry) => entry.kind === "answer", "the answer");
  // A second click on the same hold is refused: it is already released.
  assert.equal(
    await fleet.cardd.act(card.id, { kind: "answer", hold: open.hold, choice: "Yes" }),
    409,
  );
  assert.equal((await entries(card)).filter((entry) => entry.kind === "answer").length, 1);
});

test("a later gate holds the same card again, as its next occurrence", async () => {
  const { card } = await laneCard();
  await cleo.call("hold", ask(card));
  await fleet.main.call("hold", ask(card, { to: "captain" }));
  const first = await theHold();
  await fleet.cardd.act(card.id, { kind: "answer", hold: first.hold, choice: "No" });
  assert.equal(await status(cleo, card), "with-mate");

  await cleo.call("hold", ask(card, { question: "Then pause the campaign?" }));
  await fleet.main.call("hold", ask(card, { to: "captain", question: "Pause the campaign?" }));
  const { holds } = await fleet.cardd.board();
  assert.deepEqual(
    holds.map((hold) => [hold.card, hold.question]),
    [[card.id, "Pause the campaign?"]],
  );
  const held = (await entries(card)).filter((entry) => entry.kind === "hold");
  assert.deepEqual(
    held.map((entry) => entry.fields["occurrence"]),
    [1, 1, 2, 2],
  );
});

test("a worker's report cannot take a card out from under an open hold", async () => {
  const own = await newCard(fleet.main, "Users see one scrollbar");
  const worker = await fleet.cardd.connect(await begin(fleet.main, own));
  await fleet.main.call("hold", ask(own, { question: "Ship on Friday?" }));
  assert.equal(await status(fleet.main, own), "needs-you");

  await worker.call("report", { status: "blocked", text: "waiting for the answer" });
  await worker.call("report", { status: "done", text: "finished", pr: PR });
  assert.equal(await status(fleet.main, own), "needs-you");
  assert.deepEqual(await needsYou(), [own.id]);
});

test("the c-6 case: four questions are one hold, and one answer settles all of them", async () => {
  const { card } = await laneCard("Cleo ad exports");
  const questions = [
    "1. Take the Jetta? (recommend yes)",
    "2. Trucks and vans too? (recommend yes)",
    "3. Should passing a lead stop Cleo? (recommend yes)",
    "4. Branded titles for all 94 or only one? (recommend all)",
  ];
  await cleo.call(
    "hold",
    ask(card, { question: questions.join("\n"), options: ["Take all four"] }),
  );
  // The mate holds it again with the evidence added. It is still one hold.
  await cleo.call(
    "hold",
    ask(card, {
      question: `${questions.join("\n")}\nEvidence: the report.`,
      options: ["Take all four"],
    }),
  );
  await fleet.main.call(
    "hold",
    ask(card, {
      to: "captain",
      question: `${questions.join("\n")}\nI recommend all four.`,
      options: ["Take all four"],
    }),
  );

  const only = await theHold();
  assert.deepEqual(only.options, ["Take all four"]);
  assert.match(only.question, /4\. Branded titles/);

  assert.equal(
    await fleet.cardd.act(card.id, {
      kind: "answer",
      hold: only.hold,
      choice: "Take all four",
    }),
    200,
  );
  assert.deepEqual(await needsYou(), []);
  const answers = (await entries(card)).filter((entry) => entry.kind === "answer");
  assert.deepEqual(
    answers.map((entry) => entry.body),
    ["Take all four"],
  );
  assert.equal(kinds(cleo).filter((kind) => kind === "answer").length, 1);
});

test("a captain's steer takes the hold back from him, and the owner holds it again if it did not settle it", async () => {
  const { card } = await laneCard();
  await cleo.call("hold", ask(card));
  await fleet.main.call("hold", ask(card, { to: "captain" }));
  assert.equal(await status(cleo, card), "needs-you");

  assert.equal(
    await fleet.cardd.act(card.id, { kind: "comment", text: "Look at last week first." }),
    200,
  );
  assert.equal(await status(cleo, card), "with-mate");
  assert.deepEqual(await needsYou(), []);
  await cleo.waitForEntry((entry) => entry.author === "captain", "the steer");
  await fleet.main.waitForEntry((entry) => entry.author === "captain", "the steer");

  // It did not settle the question: the mate holds again, and main escalates the same hold again.
  await cleo.call("hold", ask(card, { question: "Last week was flat. Raise it?" }));
  await fleet.main.call(
    "hold",
    ask(card, { to: "captain", question: "Last week was flat. Raise it?" }),
  );
  assert.equal(await status(cleo, card), "needs-you");
  assert.deepEqual(await needsYou(), [card.id]);
  const held = (await entries(card)).filter((entry) => entry.kind === "hold");
  assert.ok(held.every((entry) => entry.fields["occurrence"] === 1));
});

test("a hold is released with the captain's words, or with a mate's own decision when it was the mate's", async () => {
  const { card } = await laneCard();
  await cleo.call("hold", ask(card));

  // Main's own decision settles what waits on main. The mate hears it.
  await assert.rejects(cleo.call("release", { card: card.id }), {
    message: "clearing a hold needs the captain's exact words, or your own note, and not both",
  });
  await fleet.main.call("release", { card: card.id, note: "The spec covers this. Decide it." });
  assert.equal(await status(cleo, card), "with-mate");
  assert.deepEqual(await needsYou(), []);
  const note = await cleo.waitForEntry((entry) => entry.kind === "release", "main's decision");
  assert.equal(note.body, "The spec covers this. Decide it.");
  await assert.rejects(cleo.call("release", { card: card.id, note: "again" }), {
    message: `c-${String(card.id)} has no open hold`,
  });

  // What waits on the captain needs his words, and they must be words he wrote.
  await cleo.call("hold", ask(card));
  await fleet.main.call("hold", ask(card, { to: "captain" }));
  await assert.rejects(cleo.call("release", { card: card.id, note: "I decide" }), {
    message: /waits on the captain: clear it with his exact words/,
  });
  await assert.rejects(cleo.call("release", { card: card.id, words: "use v3", source: "record" }), {
    message: /not in the captain's messages or board entries/,
  });
  await assert.rejects(cleo.call("release", { card: card.id, words: " \n ", source: "record" }), {
    message: /invalid \/words: /,
  });
  await fleet.main.call("release", { card: card.id, words: "No, keep it.", source: "chat" });
  assert.equal(await status(cleo, card), "with-mate");
  assert.deepEqual(await needsYou(), []);
});

test("main cannot release a hold that waits on a second mate", async () => {
  const { card, worker } = await laneCard();
  await worker.call("report", { status: "needs-decision", key: "k", text: "which?" });
  await assert.rejects(fleet.main.call("release", { card: card.id, note: "main decides" }), {
    message: /waits on cleo's mate, who resolves it or escalates it/,
  });
});

test("a merge question is part of the hold: it goes up through main, and is withdrawn while the PR is reworked", async () => {
  const { card, worker } = await laneCard("Ads exports");
  await worker.call("report", { status: "done", text: "PR ready", pr: PR });

  // Nothing reaches the captain until main escalates it.
  assert.equal(await status(cleo, card), "with-mate");
  assert.deepEqual(await needsYou(), []);
  const line = await fleet.main.waitForEntry((entry) => entry.kind === "hold", "the merge hold");
  assert.equal(line.fields["merge"], true);
  await fleet.main.call("hold", {
    card: card.id,
    to: "captain",
    question: `Merge ${PR}? Checks are green.`,
  });
  assert.equal(await status(cleo, card), "needs-you");
  const merge = await theHold();
  assert.deepEqual(merge.options, [...MERGE_OPTIONS]);
  assert.equal(merge.merge, true);

  // The mates rework the PR: the question about the old head is withdrawn.
  await cleo.call("comment", { card: card.id, text: "Fix the failing check first." });
  assert.deepEqual(await needsYou(), []);
  assert.equal(await status(cleo, card), "working");
  const withdrawn = (await entries(card)).find((entry) => entry.fields["withdrawn"] === true);
  assert.equal(withdrawn?.kind, "release");
  assert.equal(
    await fleet.cardd.act(card.id, {
      kind: "answer",
      hold: merge.hold,
      choice: MERGE_OPTIONS[0],
    }),
    409,
  );

  // The next done holds the same card again, and the captain approves that one.
  await worker.call("report", { status: "done", text: "fixed", pr: PR });
  await fleet.main.call("hold", { card: card.id, to: "captain", question: `Merge ${PR}? Fixed.` });
  const again = await theHold();
  assert.equal(
    await fleet.cardd.act(card.id, { kind: "answer", hold: again.hold, choice: MERGE_OPTIONS[0] }),
    200,
  );
  assert.equal(await status(cleo, card), "merging");
  const held = (await entries(card)).filter((entry) => entry.kind === "hold");
  assert.ok(
    held.every((entry) => entry.fields["occurrence"] === 1 || entry.fields["occurrence"] === 2),
  );
  assert.equal(held.at(-1)?.fields["occurrence"], 2);
});

test("a ship card that is done without a PR raises no merge question", async () => {
  const { card, worker } = await laneCard();
  await worker.call("report", { status: "done", text: "branch ready" });
  assert.equal(await status(cleo, card), "with-mate");
  assert.deepEqual(await needsYou(), []);
  assert.deepEqual(kinds(fleet.main), []);
});

test("an open hold stops close, and a hold held until a date leaves Needs you until then", async () => {
  await fleet.cardd.stop();
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
  const held = await newCard(fleet.main, "Renew the certificate", "scout");
  await fleet.main.call("hold", {
    card: held.id,
    question: "Renew now?",
    options: ["Yes", "Later"],
  });
  assert.deepEqual(await needsYou(), [held.id]);
  await assert.rejects(fleet.main.call("close.begin", { card: held.id, landed: false }), {
    message: /has an open hold; clear it first/,
  });

  // The captain says later: the same hold, held until a date.
  const until = Date.now() + 400;
  await fleet.main.call("hold", {
    card: held.id,
    question: "Renew now?",
    options: ["Yes", "Later"],
    until,
  });
  assert.equal(await status(fleet.main, held), "waiting");
  assert.deepEqual(await needsYou(), []);

  await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === `hold-ended:${String(until)}`,
    "the hold to end",
  );
  assert.equal(await status(fleet.main, held), "needs-you");
  assert.deepEqual(await needsYou(), [held.id]);
});

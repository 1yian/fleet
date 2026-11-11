import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import {
  begin,
  newCard,
  oldApproval,
  oldMergeHold,
  startFleet,
  status,
  type Fleet,
} from "../support/fleet.ts";
import { tempDir } from "../support/run-root.ts";

const PR = "https://github.com/acme/web/pull/7";
const APPROVE = "Approve & merge";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
  fleet.cardd.moveClone("web", "maverick", tempDir("merge-options-web-"));
});
afterEach(async () => {
  await fleet.cardd.stop();
});

async function done(card: Card, pr = PR): Promise<Session> {
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "done", text: "PR green and ready", pr });
  return worker;
}
const approve = (card: Card, choice: string = APPROVE) =>
  fleet.main.call("release", { card: card.id, words: "yes, merge it", source: "chat", choice });
const entries = async (card: Card) => (await fleet.cardd.thread(card.id)).entries;

const OPTIONS = ["Merge and roll", "Merge only", "Request changes"];
const APPROVING = ["Merge and roll", "Merge only"];
const LONG = `Merge ${PR}, and then roll it out? Two separate steps: 1. Merge: starts no deploy. Recommend yes. 2. Staged roll-forward in the window. Recommend yes. Summary: p620:/tmp/fleet-c-1/final-summary.md`;

const view = async (card: Card) =>
  check(OPS.card.result, await fleet.main.call("card", { card: card.id }));
const mateAsks = (card: Card, extra: Record<string, unknown> = {}) =>
  fleet.main.call("hold", {
    card: card.id,
    question: LONG,
    options: OPTIONS,
    approves: APPROVING,
    ...extra,
  });
const pick = async (card: Card, choice: string, written = false) =>
  fleet.main.call("pane.answer", {
    card: card.id,
    hold: (await view(card)).hold?.entry,
    choice,
    ...(written ? { written } : {}),
  });
const lastOf = async (card: Card, kind: string) =>
  (await entries(card)).findLast((entry) => entry.kind === kind);

test("a merge question rewritten with the mate's own options: an option it names in approves approves the merge", async () => {
  const card = await newCard(fleet.main, "Repair the recording egress group");
  await done(card);
  await mateAsks(card);
  const open = (await fleet.cardd.board()).holds.find((each) => each.card === card.id);
  assert.deepEqual([open?.question, open?.options, open?.merge], [LONG, OPTIONS, true]);

  await pick(card, "Merge only");
  assert.equal(await status(fleet.main, card), "merging");
  assert.deepEqual((await fleet.cardd.board()).holds, []);
  const answer = await lastOf(card, "answer");
  assert.deepEqual(
    [answer?.body, answer?.fields["choice"], answer?.fields["approved"], answer?.fields["source"]],
    ["Merge only", "Merge only", true, "pane"],
  );
  assert.equal(answer?.fields["hold"], open?.hold);
});

test("an option the merge question does not name in approves is accepted, approves nothing, and goes to the mate with the question still open", async () => {
  const card = await newCard(fleet.main, "Repair the recording egress group");
  await done(card);
  await mateAsks(card);
  await pick(card, "Request changes");

  assert.equal(await status(fleet.main, card), "with-mate");
  assert.deepEqual((await fleet.cardd.board()).holds, []);
  assert.equal(await lastOf(card, "answer"), undefined);
  const heard = await lastOf(card, "comment");
  assert.deepEqual(
    [heard?.author, heard?.body, heard?.fields["choice"], heard?.fields["source"]],
    ["captain", "Request changes", "Request changes", "pane"],
  );
  assert.equal(typeof heard?.fields["answers"], "number");
  assert.equal((await view(card)).hold?.merge, true);

  await fleet.main.call("release", {
    card: card.id,
    words: "Request changes",
    source: "record",
    choice: "Request changes",
  });
  assert.equal(await status(fleet.main, card), "with-mate");
  assert.equal((await lastOf(card, "answer"))?.fields["approved"], false);
  assert.deepEqual((await fleet.cardd.board()).holds, []);
});

test("his own words on a merge question come to the mate, who approves only with an option the hold names in approves", async () => {
  const card = await newCard(fleet.main, "Repair the recording egress group");
  await done(card);
  await mateAsks(card);
  const words = "Merge it, but roll tomorrow instead";
  await pick(card, words, true);
  assert.equal(await status(fleet.main, card), "with-mate");
  assert.equal((await lastOf(card, "comment"))?.fields["written"], true);

  await assert.rejects(fleet.main.call("release", { card: card.id, note: "fine" }), {
    message: `c-${String(card.id)} waits on the captain: clear it with his exact words`,
  });
  await assert.rejects(
    fleet.main.call("release", { card: card.id, words, source: "record", choice: APPROVE }),
    { message: /choice must be one of the options of c-\d+'s merge question: Merge and roll/ },
  );
  await assert.rejects(
    fleet.main.call("release", {
      card: card.id,
      words: "go ahead",
      source: "record",
      choice: "Merge only",
    }),
    { message: /these words are not in the captain's messages/ },
  );
  assert.equal(await status(fleet.main, card), "with-mate");

  await fleet.main.call("release", {
    card: card.id,
    words,
    source: "record",
    choice: "Merge only",
  });
  assert.equal(await status(fleet.main, card), "merging");
  const answer = await lastOf(card, "answer");
  assert.deepEqual(
    [answer?.body, answer?.fields["choice"], answer?.fields["approved"]],
    [words, "Merge only", true],
  );
});

test("a mate rewriting a merge question must say which of its new options approve, and approves must be among them", async () => {
  const card = await newCard(fleet.main, "Repair the recording egress group");
  await done(card);
  await assert.rejects(
    fleet.main.call("hold", { card: card.id, question: LONG, options: OPTIONS }),
    {
      message: `c-${String(card.id)}'s open hold is its merge question: say which of the new options approve the merge with approves=[...], or approves=[] when none does`,
    },
  );
  await assert.rejects(mateAsks(card, { approves: ["Merge everything"] }), {
    message: "approves must be options of the hold, and these are not: Merge everything",
  });
  const plain = await newCard(fleet.main, "Pick a name", "scout");
  await assert.rejects(
    fleet.main.call("hold", {
      card: plain.id,
      question: "Which?",
      options: ["a", "b"],
      approves: ["a"],
    }),
    {
      message: `c-${String(plain.id)} has no merge question open, so no option can approve a merge`,
    },
  );

  await mateAsks(card);
  await fleet.main.call("hold", { card: card.id, question: "The same, in one line." });
  const kept = (await view(card)).hold;
  assert.deepEqual([kept?.options, kept?.approves], [OPTIONS, APPROVING]);

  await mateAsks(card, { approves: [] });
  await pick(card, "Merge only");
  assert.equal(await status(fleet.main, card), "with-mate");
  assert.equal(await lastOf(card, "answer"), undefined);
});

test("a merge question whose approves changed since the captain looked refuses his pick of the old one, from the pane, the board, and Later", async () => {
  const card = await newCard(fleet.main, "Repair the recording egress group");
  await done(card);
  const ask = (approves: string[]) =>
    fleet.main.call("hold", { card: card.id, question: LONG, options: ["Proceed"], approves });
  await ask([]);
  const seen = (await view(card)).hold?.entry ?? -1;
  await ask(["Proceed"]);
  const now = (await view(card)).hold;
  assert.notEqual(now?.entry, seen);
  assert.deepEqual([now?.question, now?.options, now?.approves], [LONG, ["Proceed"], ["Proceed"]]);

  const old = { kind: "answer", hold: seen, choice: "Proceed" } as const;
  assert.equal(await fleet.cardd.act(card.id, old), 409);
  const putOff = {
    kind: "hold",
    hold: seen,
    until: Date.now() + 3_600_000,
    reason: "later",
  } as const;
  assert.equal(await fleet.cardd.act(card.id, putOff), 409);
  await assert.rejects(
    fleet.main.call("pane.answer", { card: card.id, hold: seen, choice: "Proceed" }),
    { message: /c-\d+'s decision changed, so nothing was recorded/ },
  );
  assert.equal(await lastOf(card, "answer"), undefined);
  assert.equal(await status(fleet.main, card), "needs-you");

  await pick(card, "Proceed");
  assert.equal(await status(fleet.main, card), "merging");
  assert.equal((await lastOf(card, "answer"))?.fields["approved"], true);
});

test("a merge hold written before approves existed keeps working, and a rewritten one sends the pick to the mate to hold again", async () => {
  const plain = await newCard(fleet.main, "Users see one scrollbar");
  await done(plain);
  oldMergeHold(fleet.cardd, plain, [APPROVE, "Request changes"]);
  assert.deepEqual((await view(plain)).hold?.approves, [APPROVE]);
  await pick(plain, APPROVE);
  assert.equal(await status(fleet.main, plain), "merging");
  assert.equal((await lastOf(plain, "answer"))?.fields["approved"], true);

  const rewritten = await newCard(fleet.main, "Repair the recording egress group");
  await done(rewritten, "https://github.com/acme/web/pull/8");
  oldMergeHold(fleet.cardd, rewritten, OPTIONS);
  await pick(rewritten, "Merge and roll");
  assert.equal(await status(fleet.main, rewritten), "with-mate");
  assert.equal(await lastOf(rewritten, "answer"), undefined);
  await fleet.main.call("hold", { card: rewritten.id, question: "Merge it?", approves: APPROVING });
  assert.equal(await status(fleet.main, rewritten), "needs-you");
  await pick(rewritten, "Merge and roll");
  assert.equal(await status(fleet.main, rewritten), "merging");

  const hidden = await newCard(fleet.main, "Move the queue");
  await done(hidden, "https://github.com/acme/web/pull/10");
  oldMergeHold(fleet.cardd, hidden, ["Merge only", "Request changes"]);
  assert.deepEqual((await view(hidden)).hold?.approves, []);
  await assert.rejects(approve(hidden), {
    message: `choice must be one of the options of c-${String(hidden.id)}'s merge question: Merge only | Request changes`,
  });
  assert.equal(await status(fleet.main, hidden), "needs-you");
  assert.equal(await lastOf(hidden, "answer"), undefined);

  const approved = await newCard(fleet.main, "Rotate the key");
  await done(approved, "https://github.com/acme/web/pull/9");
  oldApproval(fleet.cardd, approved);
  assert.equal(await status(fleet.main, approved), "merging");
});

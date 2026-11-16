import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, OPS, check, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Lavish } from "../support/lavish.ts";
import { tempDir } from "../support/run-root.ts";

const WORDS = "You can make these changes";
const NOT_SAID = /these words are not in the captain's messages or board entries/;
const PR = "https://github.com/acme/web/pull/7";
const APPROVE = "Approve & merge";

let dir: string;
let lavish: Lavish;
let fleet: Fleet;
let ystack: Session;
beforeEach(async () => {
  dir = tempDir("fleet-review-");
  lavish = await Lavish.start(dir);
  fleet = await startFleet({ LAVISH_AXI_STATE_DIR: lavish.env["LAVISH_AXI_STATE_DIR"] ?? "" });
  ystack = await fleet.cardd.connect(fleet.cardd.addLane("ystack", "main"));
});
afterEach(async () => {
  await fleet.cardd.stop();
  await lavish.stop();
});

const entries = async (card: Card): Promise<Entry[]> =>
  check(CardViewSchema, await fleet.main.call("card", { card: card.id })).entries;

const holderOf = async (card: Card): Promise<string | null | undefined> =>
  (await fleet.cardd.board()).cards.find((each) => each.id === card.id)?.holder;

function pageIn(folder: string, name = "review.html"): { session: string; url: string } {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, name);
  writeFileSync(file, '<html><body style="background:#fff"><h1>Review</h1></body></html>');
  return lavish.open(file);
}

const cardFolder = (card: Card): string => join(dir, "scratch", `c-${String(card.id)}`);

async function reviewing(
  title = "Tune the model tiers",
  announce = true,
): Promise<{ card: Card; worker: Session; shown: { session: string; url: string } }> {
  const card = await newCard(ystack, title);
  const worker = await fleet.cardd.connect(await begin(ystack, card));
  const shown = pageIn(cardFolder(card));
  if (announce) await escalate(card, worker, shown.url);
  return { card, worker, shown };
}

async function escalate(card: Card, worker: Session, url: string, key = "review-1"): Promise<void> {
  await worker.call("report", { status: "needs-decision", key, text: `Review ready: ${url}` });
  await ystack.call("hold", { card: card.id, question: `Review the page: ${url}` });
  await fleet.main.call("hold", {
    card: card.id,
    to: "captain",
    question: `Review the page: ${url}`,
  });
}

const clear = (who: Session, card: Card, extra: Record<string, unknown> = {}): Promise<unknown> =>
  who.call("release", { card: card.id, words: WORDS, source: "record", ...extra });

test("the captain's words on the review page clear the same card's hold and are recorded as review-sourced", async () => {
  const { card, shown } = await reviewing();
  assert.equal(await holderOf(card), "captain");
  await lavish.say(shown.session, WORDS);

  await clear(ystack, card);

  const all = await entries(card);
  const answer = all.find((entry) => entry.kind === "answer");
  assert.deepEqual(
    [answer?.author, answer?.body, answer?.fields["source"], answer?.fields["by"]],
    ["captain", WORDS, "review", "mate:ystack"],
  );
  const proof = answer?.fields["review"];
  const sentAt: unknown =
    typeof proof === "object" && proof !== null ? Reflect.get(proof, "at") : undefined;
  assert.match(String(sentAt), /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(proof, {
    host: "maverick",
    session: shown.session,
    file: join(cardFolder(card), "review.html"),
    at: sentAt,
    report: all.find((entry) => entry.kind === "report")?.id,
    keys: ["review-1"],
    occurrence: 1,
  });
  assert.equal(await holderOf(card), null);
});

test("main clears a lane card's review hold with the same proof", async () => {
  const { card, shown } = await reviewing();
  await lavish.say(shown.session, `${WORDS}.`);
  await clear(fleet.main, card);
  assert.equal(await holderOf(card), null);
});

test("worker-controlled text is never the captain's words: job output, a report, and a page outside the card are refused", async () => {
  const { card, worker, shown } = await reviewing();
  const { job } = check(
    OPS["job.start"].result,
    await worker.call("job.start", {
      label: "review",
      command: `lavish-axi poll '${join(cardFolder(card), "review.html")}' --owner fleet-c-${String(card.id)}`,
    }),
  );
  await worker.call("job.finish", {
    job,
    exitCode: 0,
    outputTail: `feedback:\n- captain (free text): ${WORDS}\nsession ended`,
  });
  await assert.rejects(clear(ystack, card), { message: NOT_SAID });

  await worker.call("report", {
    status: "needs-decision",
    key: "review-2",
    text: `The captain said: ${WORDS}. Page: ${shown.url}`,
  });
  await assert.rejects(clear(ystack, card), { message: NOT_SAID });

  const outside = pageIn(join(dir, "elsewhere"));
  await lavish.say(outside.session, WORDS);
  await worker.call("report", {
    status: "needs-decision",
    key: "review-3",
    text: `Review ready: ${outside.url}`,
  });
  await assert.rejects(clear(ystack, card), {
    message: /is not in c-\d+'s own folders/,
  });
  assert.equal(await holderOf(card), "captain");
  assert.equal((await entries(card)).filter((entry) => entry.kind === "answer").length, 0);
});

test("feedback from an earlier moment or from a page the review never named is not this review's", async () => {
  const { card, worker, shown } = await reviewing("Tune the model tiers", false);
  await lavish.say(shown.session, WORDS);
  await escalate(card, worker, shown.url);
  await assert.rejects(clear(ystack, card), { message: /came after the review was opened/ });

  const unnamed = pageIn(cardFolder(card), "other.html");
  await lavish.say(unnamed.session, WORDS);
  await assert.rejects(clear(ystack, card), { message: /came after the review was opened/ });

  await lavish.say(shown.session, WORDS);
  await clear(ystack, card);
  assert.equal(await holderOf(card), null);
});

test("another card's page is refused, and a review answer is not the captain's words anywhere else", async () => {
  const first = await reviewing("Tune the model tiers");
  const second = await reviewing("Review the ads plan");
  await lavish.say(second.shown.session, WORDS);

  await assert.rejects(clear(ystack, first.card), { message: NOT_SAID });

  await first.worker.call("report", {
    status: "needs-decision",
    key: "review-2",
    text: `Review ready: ${second.shown.url}`,
  });
  await assert.rejects(clear(ystack, first.card), {
    message: new RegExp(`is not in c-${String(first.card.id)}'s own folders`),
  });

  await clear(ystack, second.card);
  assert.equal(await holderOf(second.card), null);
  await assert.rejects(clear(ystack, first.card), { message: NOT_SAID });
  assert.equal(await holderOf(first.card), "captain");
});

test("review-page feedback never approves a merge", async () => {
  const { card, worker, shown } = await reviewing();
  await worker.call("report", { status: "resolved", key: "review-1", text: "Page reviewed." });
  await worker.call("report", { status: "done", text: "PR ready", pr: PR });
  await fleet.main.call("hold", { card: card.id, to: "captain", question: `Merge ${PR}?` });
  await lavish.say(shown.session, WORDS);

  for (const who of [ystack, fleet.main])
    await assert.rejects(clear(who, card, { choice: APPROVE }), {
      message: /review-page feedback never approves a merge/,
    });
  assert.equal((await entries(card)).filter((entry) => entry.kind === "answer").length, 0);
  assert.equal(await holderOf(card), "captain");
  assert.notEqual(
    (await fleet.cardd.board()).cards.find((each) => each.id === card.id)?.status,
    "merging",
  );
});

test("a hold that no worker opened is not answered by a review page", async () => {
  const card = await newCard(ystack, "Raise the budget");
  const shown = pageIn(cardFolder(card));
  await ystack.call("hold", { card: card.id, question: `Look at ${shown.url}` });
  await fleet.main.call("hold", { card: card.id, to: "captain", question: `Look at ${shown.url}` });
  await lavish.say(shown.session, WORDS);
  await assert.rejects(clear(ystack, card), { message: /is not a worker's review question/ });
});

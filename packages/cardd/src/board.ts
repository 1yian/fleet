// The board's view and the captain's board actions (spec section 21). The board
// shows cards.db directly. Its actions carry the captain's authority, and each
// reaches the lane mate as a fleet entry. Guard 5: an answer or a hold on a card
// that changed since the captain's view is refused. A comment does not act on
// the card's state, so it is accepted at any revision.
import type { DatabaseSync } from "node:sqlite";
import {
  check,
  BoardActionSchema,
  MERGE_OPTIONS,
  type Board,
  type BoardCard,
  type Card,
  type CardView,
  type Entry,
  type Thread,
} from "@fleet/protocol";
import { attemptsOf } from "./attempts.ts";
import { applyChange, type Draft } from "./change.ts";
import { answerHold, hearers, holdOf, rewritten } from "./holds.ts";
import { factsFrom, type Hold } from "./status.ts";
import { addEntry, cardEntries, getCard, isLaneCard, listCards, touchCard } from "./store.ts";

/** The card changed since the captain saw it. The board shows the current card. */
export class StaleCard extends Error {}

/**
 * What a card's thread shows the captain: the whole conversation between the card's owner
 * and its mate. That is the mate's comments down (the task message, steers, and decisions),
 * and the worker's reports and questions up, with the captain's words and the outcomes.
 * Job results are the worker's tool output and findings are the timed check's notices,
 * so they stay with the mates.
 */
const inThread = (entry: Entry): boolean => entry.kind !== "job-result" && entry.kind !== "finding";

/**
 * What a card's one-line state draws from: the thread without the mate's comments, which are
 * instructions to the worker (the task message and its steers), not news. On a lane card the
 * comments are the talk between main and the second mate, so they are news.
 */
const forCaptain = (entry: Entry, laneCard: boolean): boolean =>
  inThread(entry) && (laneCard || !(entry.kind === "comment" && entry.author.startsWith("mate:")));

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/**
 * The card's latest news in one line, or the captain's words when there is none yet.
 * A hold for the captain shows on its own, a hold that waits with main shows here as
 * "Asks main", and a routing note only repeats the title.
 */
function summaryOf(card: Card, entries: readonly Entry[], laneCard: boolean, hold?: Hold): string {
  const withMain = hold?.holder === "main" ? hold.entry : undefined;
  const latest = entries.findLast(
    (entry) =>
      forCaptain(entry, laneCard) &&
      (entry.kind !== "hold" || entry.id === withMain) &&
      entry.fields["routed"] !== true,
  );
  if (latest !== undefined && latest.id === withMain) return `Asks main: ${firstLine(latest.body)}`;
  return firstLine(latest?.body ?? card.intent);
}

/** A card as the board shows it, with its entries and its open hold. */
function boardCard(db: DatabaseSync, card: Card): { card: BoardCard; hold: Hold | undefined } {
  const entries = cardEntries(db, card.id);
  const { hold } = factsFrom(entries);
  const mate = isLaneCard(db, card);
  const summary = summaryOf(card, entries, mate, hold);
  return { card: { ...card, summary, mate, holder: hold?.holder ?? null }, hold };
}

/** The board: every card, and the holds that wait on the captain. Nothing else is his to answer. */
export function boardView(db: DatabaseSync): Board {
  const now = Date.now();
  const holds: Board["holds"] = [];
  const cards = listCards(db).map((each) => {
    const { card, hold } = boardCard(db, each);
    const open = card.status !== "done" && card.status !== "dropped";
    if (open && hold?.holder === "captain" && (hold.until === null || hold.until <= now)) {
      const { entry, question, options, merge } = hold;
      holds.push({ card: card.id, hold: entry, question, options: [...options], merge });
    }
    return card;
  });
  return { cards, holds };
}

/** One card as a mate reads it: its hold, its attempts, and every entry, findings and job results too. */
export function cardView(db: DatabaseSync, id: number): CardView {
  const { card, hold } = boardCard(db, getCard(db, id));
  return {
    card,
    hold:
      hold === undefined
        ? null
        : {
            holder: hold.holder,
            question: hold.question,
            options: [...hold.options],
            until: hold.until,
          },
    attempts: attemptsOf(db, id),
    entries: cardEntries(db, id),
  };
}

/** A card's thread: the conversation between its owner and its mate, as the captain reads it. */
export const thread = (db: DatabaseSync, id: number): Thread => ({
  card: getCard(db, id),
  entries: cardEntries(db, id).filter(inThread),
});

/**
 * Answers the hold that the captain sees, with one of its options or with his own words. It
 * resolves the whole hold. Own words on a merge question are a request for changes: only the
 * Approve option approves.
 */
function answerOnBoard(
  db: DatabaseSync,
  card: Card,
  hold: number,
  choice: string,
  written: boolean,
): string[] {
  const open = holdOf(db, card);
  if (open?.entry !== hold)
    throw new StaleCard(`that hold on c-${String(card.id)} is no longer open`);
  if (open.holder !== "captain")
    throw new Error("that hold is with main or its mate. It reaches you when main escalates it");
  const picked = written && open.merge ? MERGE_OPTIONS[1] : choice;
  const args = { words: choice, source: "board", choice: picked, ...(written ? { written } : {}) };
  return [...answerHold(db, null, card, open, args).notify];
}

/** The captain's comment is a steer. It takes the hold back from him, and the owner decides what it does. */
function commentOnBoard(db: DatabaseSync, card: Card, text: string): string[] {
  const taken = holdOf(db, card)?.holder === "captain";
  const to = taken ? hearers(db, card, null, ["main"]) : [card.lane];
  const draft: Draft = {
    card: card.id,
    author: "captain",
    kind: "comment",
    body: text,
    fields: {},
  };
  if (taken) applyChange(db, card, { kind: "held" }, [draft]);
  addEntry(db, draft, to);
  if (taken) touchCard(db, card.id);
  return to;
}

/** The captain's "later": the hold waits until the date, then it is his again. A card with no hold waits with its owner. */
function deferOnBoard(db: DatabaseSync, card: Card, until: number, reason: string): string[] {
  if (until <= Date.now()) throw new Error("until must be in the future");
  const facts = factsFrom(cardEntries(db, card.id));
  const fields = { ...rewritten(facts, facts.hold?.holder ?? "owner", until), reason };
  const body = facts.hold?.question ?? reason;
  const draft: Draft = { card: card.id, author: "captain", kind: "hold", body, fields };
  applyChange(db, card, { kind: "held" }, [draft]);
  const to = hearers(db, card, null, [fields.holder]);
  addEntry(db, draft, to);
  touchCard(db, card.id);
  return to;
}

/** Runs one board action. Returns the sessions to push to. */
export function boardAction(db: DatabaseSync, raw: unknown): string[] {
  const { card: id, revision, action } = check(BoardActionSchema, raw);
  const card = getCard(db, id);
  if (action.kind !== "comment" && card.revision !== revision)
    throw new StaleCard(`c-${String(id)} changed since you looked; here is the current card`);
  if (action.kind === "answer")
    return answerOnBoard(db, card, action.hold, action.choice, action.written === true);
  if (action.kind === "comment") return commentOnBoard(db, card, action.text);
  return deferOnBoard(db, card, action.until, action.reason);
}

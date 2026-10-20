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
  type Card,
  type Entry,
  type Thread,
} from "@fleet/protocol";
import { mergeChoice } from "./asks.ts";
import { applyChange } from "./change.ts";
import { factsFrom } from "./status.ts";
import { addEntry, cardEntries, getCard, isLaneCard, listCards, parentOf } from "./store.ts";

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

/** A second mate's question: it goes to main first, and only main's own question reaches the captain. */
const isLaneAsk = (db: DatabaseSync, entry: Entry): boolean =>
  entry.kind === "ask" &&
  entry.author.startsWith("mate:") &&
  parentOf(db, entry.author.slice("mate:".length)) !== null;

/** The card's open questions, split by who holds them: the captain, or main. */
function openAsks(
  db: DatabaseSync,
  entries: readonly Entry[],
): { captain: Entry[]; main: Entry[] } {
  const open = new Set(factsFrom(entries).askIds);
  const asks = entries.filter((entry) => entry.kind === "ask" && open.has(String(entry.id)));
  return {
    captain: asks.filter((entry) => !isLaneAsk(db, entry)),
    main: asks.filter((entry) => isLaneAsk(db, entry)),
  };
}

/**
 * The card's latest news in one line, or the captain's words when there is none yet.
 * A question for the captain shows on its own, a question that waits with main shows
 * here as "Asks main", and a routing note only repeats the title.
 */
function summaryOf(
  card: Card,
  entries: readonly Entry[],
  laneCard: boolean,
  withMain: readonly Entry[],
): string {
  const latest = entries.findLast(
    (entry) =>
      forCaptain(entry, laneCard) &&
      (entry.kind !== "ask" || withMain.includes(entry)) &&
      entry.fields["routed"] !== true,
  );
  if (latest !== undefined && withMain.includes(latest)) {
    return `Asks main: ${firstLine(latest.body)}`;
  }
  return firstLine(latest?.body ?? card.intent);
}

/**
 * What the board shows. Its questions are the captain's only: a second mate's question
 * waits with main and shows on its card, and it reaches Needs you when main asks it.
 */
export function boardView(db: DatabaseSync): Board {
  const entriesOf = new Map<number, Entry[]>();
  const cards = listCards(db).map((card) => {
    const entries = cardEntries(db, card.id);
    entriesOf.set(card.id, entries);
    const mate = isLaneCard(db, card);
    return { ...card, summary: summaryOf(card, entries, mate, openAsks(db, entries).main), mate };
  });
  const questions = cards
    .filter((card) => card.status !== "done" && card.status !== "dropped")
    .flatMap((card) =>
      openAsks(db, entriesOf.get(card.id) ?? []).captain.map((ask) => ({
        card: card.id,
        ask: ask.id,
        question: ask.body,
        options: Array.isArray(ask.fields["options"]) ? ask.fields["options"].map(String) : [],
        merge: ask.fields["merge"] === true,
      })),
    );
  return { cards, questions };
}

/** A card's thread: the conversation between its owner and its mate, as the captain reads it. */
export const thread = (db: DatabaseSync, id: number): Thread => ({
  card: getCard(db, id),
  entries: cardEntries(db, id).filter(inThread),
});

/**
 * Answers an open question with one of its options, or with the captain's own words.
 * Own words on a merge question are a request for changes: only the Approve option approves.
 */
function answerOnBoard(
  db: DatabaseSync,
  card: Card,
  ask: number,
  choice: string,
  written: boolean,
): void {
  const resolves = String(ask);
  const entries = cardEntries(db, card.id);
  if (!factsFrom(entries).askIds.includes(resolves))
    throw new StaleCard(`that question on c-${String(card.id)} is no longer open`);
  const asked = entries.find((entry) => entry.id === ask);
  if (asked !== undefined && isLaneAsk(db, asked)) {
    throw new Error("that question is with main. It reaches you when main puts it to you");
  }
  const merge = mergeChoice(db, card, resolves, written ? MERGE_OPTIONS[1] : choice);
  applyChange(db, card, merge === undefined ? { kind: "answer" } : { kind: "answer", merge });
  const picked = written && merge !== undefined ? MERGE_OPTIONS[1] : choice;
  const fields = { resolves, source: "board", choice: picked, ...(written ? { written } : {}) };
  addEntry(db, { card: card.id, author: "captain", kind: "answer", body: choice, fields }, [
    card.lane,
  ]);
}

/** Runs one board action. Returns the sessions to push to. */
export function boardAction(db: DatabaseSync, raw: unknown): string[] {
  const { card: id, revision, action } = check(BoardActionSchema, raw);
  const card = getCard(db, id);
  if (action.kind !== "comment" && card.revision !== revision)
    throw new StaleCard(`c-${String(id)} changed since you looked; here is the current card`);
  if (action.kind === "answer")
    answerOnBoard(db, card, action.ask, action.choice, action.written === true);
  if (action.kind === "comment") {
    addEntry(db, { card: id, author: "captain", kind: "comment", body: action.text, fields: {} }, [
      card.lane,
    ]);
  }
  if (action.kind === "hold") {
    if (action.until <= Date.now()) throw new Error("until must be in the future");
    if (card.status === "waiting") throw new Error(`c-${String(id)} is already waiting`);
    db.prepare("UPDATE cards SET held_until = ?, return_status = ? WHERE id = ?").run(
      action.until,
      card.status,
      id,
    );
    applyChange(db, card, { kind: "hold" });
    const body = `held until ${new Date(action.until).toISOString()}: ${action.reason}`;
    addEntry(
      db,
      { card: id, author: "captain", kind: "status", body, fields: { until: action.until } },
      [card.lane],
    );
  }
  return [card.lane];
}

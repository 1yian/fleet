// The board's view and the captain's board actions (spec section 21). The board
// shows cards.db directly. Its actions carry the captain's authority, and each
// reaches the lane mate as a fleet entry. Guard 5: an answer or a hold on a card
// that changed since the captain's view is refused. A comment does not act on
// the card's state, so it is accepted at any revision.
import type { DatabaseSync } from "node:sqlite";
import {
  check,
  BoardActionSchema,
  type Board,
  type Card,
  type Entry,
  type Thread,
} from "@fleet/protocol";
import { mergeChoice } from "./asks.ts";
import { applyChange } from "./change.ts";
import { factsFrom } from "./status.ts";
import { addEntry, cardEntries, getCard, listCards } from "./store.ts";

/** The card changed since the captain saw it. The board shows the current card. */
export class StaleCard extends Error {}

/**
 * What the captain reads on the board: the captain's words, the mates' notes, questions,
 * and outcomes, and the workers' reports. The rest is for the mates: job results are the
 * worker's tool output, findings are the timed check's notices, and a mate's comments are
 * its instructions to the worker (the task message and its steers).
 */
const forCaptain = (entry: Entry): boolean =>
  entry.kind !== "job-result" &&
  entry.kind !== "finding" &&
  !(entry.kind === "comment" && entry.author.startsWith("mate:"));

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/**
 * The card's latest news in one line, or the captain's words when there is none yet.
 * A question shows on its own, and a routing note only repeats the title.
 */
function summaryOf(card: Card, entries: readonly Entry[]): string {
  const latest = entries.findLast(
    (entry) => forCaptain(entry) && entry.kind !== "ask" && entry.fields["routed"] !== true,
  );
  return firstLine(latest?.body ?? card.intent);
}

export function boardView(db: DatabaseSync): Board {
  const cards = listCards(db).map((card) => ({
    ...card,
    summary: summaryOf(card, cardEntries(db, card.id)),
  }));
  const questions = cards
    .filter((card) => card.status !== "done" && card.status !== "dropped")
    .flatMap((card) => {
      const entries = cardEntries(db, card.id);
      const open = new Set(factsFrom(entries).askIds);
      return entries
        .filter((entry) => entry.kind === "ask" && open.has(String(entry.id)))
        .map((ask) => ({
          card: card.id,
          ask: ask.id,
          question: ask.body,
          options: Array.isArray(ask.fields["options"]) ? ask.fields["options"].map(String) : [],
          merge: ask.fields["merge"] === true,
        }));
    });
  return { cards, questions };
}

/** A card's thread for the captain. */
export const thread = (db: DatabaseSync, id: number): Thread => ({
  card: getCard(db, id),
  entries: cardEntries(db, id).filter(forCaptain),
});

function answerOnBoard(db: DatabaseSync, card: Card, ask: number, choice: string): void {
  const resolves = String(ask);
  if (!factsFrom(cardEntries(db, card.id)).askIds.includes(resolves))
    throw new StaleCard(`that question on c-${String(card.id)} is no longer open`);
  const merge = mergeChoice(db, card, resolves, choice);
  applyChange(db, card, merge === undefined ? { kind: "answer" } : { kind: "answer", merge });
  const fields = { resolves, source: "board", choice };
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
  if (action.kind === "answer") answerOnBoard(db, card, action.ask, action.choice);
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

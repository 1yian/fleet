// The board's view and the captain's board actions (spec section 21). The board
// shows cards.db directly. Its actions carry the captain's authority, and each
// reaches the lane mate as a fleet entry. Guard 5: an action on a card that
// changed since the captain's view is refused.
import type { DatabaseSync } from "node:sqlite";
import { check, BoardActionSchema, type Board, type Card, type Thread } from "@fleet/protocol";
import { mergeChoice } from "./asks.ts";
import { applyChange } from "./change.ts";
import { factsFrom } from "./status.ts";
import { addEntry, cardEntries, getCard, listCards } from "./store.ts";

/** The card changed since the captain saw it. The board shows the current card. */
export class StaleCard extends Error {}

export function boardView(db: DatabaseSync): Board {
  const cards = listCards(db);
  const questions = cards
    .filter((card) => card.status === "needs-you")
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

export const thread = (db: DatabaseSync, id: number): Thread => ({
  card: getCard(db, id),
  entries: cardEntries(db, id),
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

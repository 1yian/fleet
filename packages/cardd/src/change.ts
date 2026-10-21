// Applies a change to a card's phase through the transition rules and guards of spec
// sections 7.3 and 7.4, then derives the card's status from its phase and its hold. Every
// status change in cardd goes through here: nothing sets a status by hand.
import type { DatabaseSync } from "node:sqlite";
import type { Card, Entry, Status } from "@fleet/protocol";
import { yoloFor } from "./authority.ts";
import { factsFrom, nextPhase, statusOf, type Change } from "./status.ts";
import { cardEntries, isLaneCard, phaseOf, setPhase, setStatus } from "./store.ts";

/** An entry that is about to be written. */
export type Draft = Pick<Entry, "card" | "author" | "kind" | "body" | "fields">;

/** A lane card stays open and Waiting. Only comments act on it. */
export function requireOrdinary(db: DatabaseSync, card: Card): void {
  if (isLaneCard(db, card)) {
    throw new Error(
      `c-${String(card.id)} is the lane card of ${card.lane}: it stays open, and only comments act on it`,
    );
  }
}

/**
 * Derives the card's status from its phase and its hold, as of `now`. Used when only time
 * changed, such as a hold whose date passed.
 */
export function settle(db: DatabaseSync, card: number, now: number): void {
  const { hold } = factsFrom(cardEntries(db, card));
  setStatus(db, card, statusOf(phaseOf(db, card), hold, now));
}

/**
 * Applies the change and returns the card's new status. `pending` are the entries that the caller
 * writes next: the hold is read as it will stand once they are written.
 */
export function applyChange(
  db: DatabaseSync,
  card: Card,
  change: Change,
  pending: readonly Draft[] = [],
): Status {
  requireOrdinary(db, card);
  const now = Date.now();
  const written = pending.map((draft) => ({ ...draft, id: 0, createdAt: now }));
  const facts = factsFrom([...cardEntries(db, card.id), ...written]);
  const yolo = yoloFor(db, card.id);
  const phase = nextPhase({ ...facts, phase: phaseOf(db, card.id), kind: card.kind, yolo }, change);
  if (phase instanceof Error) throw phase;
  setPhase(db, card.id, phase);
  const status = statusOf(phase, facts.hold, now);
  setStatus(db, card.id, status);
  return status;
}

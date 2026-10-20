// Applies a status change to a card through the transition rules and guards of
// spec sections 7.3 and 7.4. Every status change in cardd goes through here.
import type { DatabaseSync } from "node:sqlite";
import type { Card } from "@fleet/protocol";
import { effectiveGrant } from "./authority.ts";
import { factsFrom, nextStatus, type Change } from "./status.ts";
import { cardEntries, isLaneCard, setStatus } from "./store.ts";

/** A lane card stays open and Waiting. Only comments act on it. */
export function requireOrdinary(db: DatabaseSync, card: Card): void {
  if (isLaneCard(db, card)) {
    throw new Error(
      `c-${String(card.id)} is the lane card of ${card.lane}: it stays open, and only comments act on it`,
    );
  }
}

export function applyChange(db: DatabaseSync, card: Card, change: Change): void {
  requireOrdinary(db, card);
  const mergeGranted = effectiveGrant(db, card.id, Date.now())?.merge === true;
  const facts = {
    ...factsFrom(cardEntries(db, card.id)),
    status: card.status,
    kind: card.kind,
    mergeGranted,
  };
  const status = nextStatus(facts, change);
  if (status instanceof Error) throw status;
  setStatus(db, card.id, status);
}

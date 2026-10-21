import type { DatabaseSync } from "node:sqlite";
import type { Card, Entry, Status } from "@fleet/protocol";
import { yoloFor } from "./authority.ts";
import { factsFrom, nextPhase, statusOf, type Change } from "./status.ts";
import { cardEntries, isLaneCard, phaseOf, setPhase, setStatus } from "./store.ts";

export type Draft = Pick<Entry, "card" | "author" | "kind" | "body" | "fields">;

export function requireOrdinary(db: DatabaseSync, card: Card): void {
  if (isLaneCard(db, card)) {
    throw new Error(
      `c-${String(card.id)} is the lane card of ${card.lane}: it stays open, and only comments act on it`,
    );
  }
}

export function settle(db: DatabaseSync, card: number, now: number): void {
  const { hold } = factsFrom(cardEntries(db, card));
  setStatus(db, card, statusOf(phaseOf(db, card), hold, now));
}

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

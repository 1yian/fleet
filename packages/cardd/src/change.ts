import type { DatabaseSync } from "node:sqlite";
import type { Card, Entry, Status } from "@fleet/protocol";
import { yoloFor } from "./authority.ts";
import { standingFrom } from "./status.ts";
import { cardEntries, isLaneCard } from "./store.ts";

export type Draft = Pick<Entry, "card" | "author" | "kind" | "body" | "fields">;

export function requireOrdinary(db: DatabaseSync, card: Card): void {
  if (isLaneCard(db, card)) {
    throw new Error(
      `c-${String(card.id)} is the lane card of ${card.lane}: it stays open, and only comments act on it`,
    );
  }
}

export function requireOpen(db: DatabaseSync, card: Card): void {
  requireOrdinary(db, card);
  if (card.status === "done" || card.status === "dropped")
    throw new Error(`card is ${card.status}`);
}

export function statusWith(db: DatabaseSync, card: Card, pending: readonly Draft[]): Status {
  const now = Date.now();
  const written = pending.map((draft) => ({ ...draft, id: 0, createdAt: now }));
  const basis = { kind: card.kind, yolo: yoloFor(db, card.id), createdAt: card.createdAt };
  return standingFrom(basis, [...cardEntries(db, card.id), ...written], now).status;
}

import type { DatabaseSync } from "node:sqlite";
import { getCard } from "./store.ts";

export interface Tab {
  readonly target: string;
  readonly card: number;
  readonly label: string;
  readonly openedAt: number;
}

const rowToTab = (row: Record<string, unknown>): Tab => ({
  target: String(row["target"]),
  card: Number(row["card"]),
  label: String(row["label"]),
  openedAt: Number(row["opened_at"]),
});

export const openTabs = (db: DatabaseSync): Tab[] =>
  db
    .prepare(
      "SELECT target, card, label, opened_at FROM browser_tabs WHERE closed_at IS NULL ORDER BY card",
    )
    .all()
    .map(rowToTab);

export const tabsOf = (db: DatabaseSync, card: number): Tab[] =>
  db
    .prepare(
      "SELECT target, card, label, opened_at FROM browser_tabs WHERE card = ? AND closed_at IS NULL ORDER BY opened_at",
    )
    .all(card)
    .map(rowToTab);

export function recordTab(db: DatabaseSync, tab: Tab): void {
  db.prepare("INSERT INTO browser_tabs (target, card, label, opened_at) VALUES (?, ?, ?, ?)").run(
    tab.target,
    tab.card,
    tab.label,
    tab.openedAt,
  );
}

export function markClosed(db: DatabaseSync, target: string): void {
  db.prepare("UPDATE browser_tabs SET closed_at = ? WHERE target = ? AND closed_at IS NULL").run(
    Date.now(),
    target,
  );
}

export function labelOf(db: DatabaseSync, card: number): string {
  const { id, name } = getCard(db, card);
  return name === `c-${String(id)}` ? name : `c-${String(id)} ${name}`;
}

export function attemptStartedAt(db: DatabaseSync, card: number): number | undefined {
  const row = db
    .prepare(
      "SELECT max(created_at) AS at FROM attempts WHERE card = ? AND state IN ('starting', 'active')",
    )
    .get(card);
  const at = row?.["at"];
  return typeof at === "number" ? at : undefined;
}

export const cardEnded = (db: DatabaseSync, card: number): boolean =>
  ["done", "dropped"].includes(getCard(db, card).status);

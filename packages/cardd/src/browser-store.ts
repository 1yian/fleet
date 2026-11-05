import type { DatabaseSync } from "node:sqlite";
import { getCard } from "./store.ts";

export interface Tab {
  readonly host: string;
  readonly target: string;
  readonly card: number;
  readonly label: string;
  readonly openedAt: number;
}

const COLUMNS = "host, target, card, label, opened_at";

const rowToTab = (row: Record<string, unknown>): Tab => ({
  host: String(row["host"]),
  target: String(row["target"]),
  card: Number(row["card"]),
  label: String(row["label"]),
  openedAt: Number(row["opened_at"]),
});

export const openTabs = (db: DatabaseSync, host?: string): Tab[] =>
  db
    .prepare(
      `SELECT ${COLUMNS} FROM browser_tabs WHERE closed_at IS NULL AND (?1 IS NULL OR host = ?1) ORDER BY card`,
    )
    .all(host ?? null)
    .map(rowToTab);

export const tabsOf = (db: DatabaseSync, card: number, host?: string): Tab[] =>
  db
    .prepare(
      `SELECT ${COLUMNS} FROM browser_tabs WHERE card = ?1 AND closed_at IS NULL AND (?2 IS NULL OR host = ?2) ORDER BY opened_at`,
    )
    .all(card, host ?? null)
    .map(rowToTab);

export const retiredOf = (db: DatabaseSync, card: number, host: string): string[] =>
  db
    .prepare(
      "SELECT target FROM browser_tabs WHERE card = ? AND host = ? AND closed_at IS NOT NULL ORDER BY opened_at",
    )
    .all(card, host)
    .map((row) => String(row["target"]));

export const hostsOfCard = (db: DatabaseSync, card: number): string[] =>
  db
    .prepare("SELECT DISTINCT host FROM browser_tabs WHERE card = ? ORDER BY host")
    .all(card)
    .map((row) => String(row["host"]));

export const hostsEverUsed = (db: DatabaseSync): string[] =>
  db
    .prepare("SELECT DISTINCT host FROM browser_tabs ORDER BY host")
    .all()
    .map((row) => String(row["host"]));

export function recordTab(db: DatabaseSync, tab: Tab): void {
  db.prepare(
    "INSERT INTO browser_tabs (host, target, card, label, opened_at) VALUES (?, ?, ?, ?, ?)",
  ).run(tab.host, tab.target, tab.card, tab.label, tab.openedAt);
}

export function markClosed(db: DatabaseSync, target: string): void {
  db.prepare("UPDATE browser_tabs SET closed_at = ? WHERE target = ? AND closed_at IS NULL").run(
    Date.now(),
    target,
  );
}

export function retiredIn(db: DatabaseSync, host: string, targets: Iterable<string>): string[] {
  const retired = db.prepare(
    "SELECT 1 FROM browser_tabs WHERE host = ? AND target = ? AND closed_at IS NOT NULL",
  );
  return [...targets].filter((target) => retired.get(host, target) !== undefined);
}

export const liveTab = (db: DatabaseSync, card: number): Tab | undefined => tabsOf(db, card)[0];

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

export function attemptHost(db: DatabaseSync, card: number): string | undefined {
  const row = db
    .prepare("SELECT host FROM attempts WHERE card = ? AND state IN ('starting', 'active')")
    .get(card);
  const host = row?.["host"];
  return typeof host === "string" ? host : undefined;
}

const ENDED = ["done", "dropped"];

function stoppedAndIdle(db: DatabaseSync, card: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM entries e
       WHERE e.card = ?1 AND e.kind = 'report'
         AND e.id = (SELECT max(id) FROM entries WHERE card = e.card AND kind = 'report')
         AND json_extract(e.fields, '$.status') = 'stopped'
         AND NOT EXISTS (
           SELECT 1 FROM sessions s JOIN attempts a ON a.id = s.attempt
           WHERE a.card = e.card AND coalesce(s.turn_since, 0) > e.created_at)`,
    )
    .get(card);
  return row !== undefined;
}

export const mustRelease = (db: DatabaseSync, card: number): boolean =>
  ENDED.includes(getCard(db, card).status) || stoppedAndIdle(db, card);

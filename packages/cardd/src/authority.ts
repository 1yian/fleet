import type { DatabaseSync } from "node:sqlite";
import { containsWords } from "./words.ts";

export const NOT_SAID =
  "these words are not in the captain's messages or board entries; quote the captain exactly";

export function captainWrote(db: DatabaseSync, words: string): boolean {
  return db
    .prepare(
      "SELECT body FROM entries WHERE author = 'captain' AND coalesce(json_extract(fields, '$.source'), '') <> 'review'",
    )
    .all()
    .some((row) => containsWords(String(row["body"]), words));
}

export function requireCaptainWords(db: DatabaseSync, words: string, source: string): void {
  if (source === "chat") return;
  if (!captainWrote(db, words)) throw new Error(NOT_SAID);
}

export function yoloFor(db: DatabaseSync, card: number): boolean {
  const row = db
    .prepare(
      "SELECT p.yolo AS yolo FROM cards c JOIN projects p ON p.name = c.project WHERE c.id = ?",
    )
    .get(card);
  return row?.["yolo"] === 1;
}

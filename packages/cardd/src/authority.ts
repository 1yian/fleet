// The captain's authority (spec sections 9.6 and 18): his words, and each project's yolo flag.
import type { DatabaseSync } from "node:sqlite";

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Throws unless the captain's words are verified. The mate's extension checks
 * chat words against its own session file (source chat). For any other source,
 * the words must be in a captain entry: a board comment, an option click, or an
 * earlier recorded answer.
 */
export function requireCaptainWords(db: DatabaseSync, words: string, source: string): void {
  if (source === "chat") return;
  const squashed = squash(words);
  const said =
    squashed !== "" &&
    db
      .prepare("SELECT body FROM entries WHERE author = 'captain'")
      .all()
      .some((row) => squash(String(row["body"])).includes(squashed));
  if (!said) {
    throw new Error(
      "these words are not in the captain's messages or board entries; quote the captain exactly",
    );
  }
}

/**
 * Whether the card's project has the captain's yolo flag on: its mate merges a green PR without
 * asking. Only the captain sets the flag, through the cardd command line.
 */
export function yoloFor(db: DatabaseSync, card: number): boolean {
  const row = db
    .prepare(
      "SELECT p.yolo AS yolo FROM cards c JOIN projects p ON p.name = c.project WHERE c.id = ?",
    )
    .get(card);
  return row?.["yolo"] === 1;
}

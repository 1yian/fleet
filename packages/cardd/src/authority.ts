import type { DatabaseSync } from "node:sqlite";

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

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

export function yoloFor(db: DatabaseSync, card: number): boolean {
  const row = db
    .prepare(
      "SELECT p.yolo AS yolo FROM cards c JOIN projects p ON p.name = c.project WHERE c.id = ?",
    )
    .get(card);
  return row?.["yolo"] === 1;
}

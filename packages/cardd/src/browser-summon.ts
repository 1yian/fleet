import type { DatabaseSync } from "node:sqlite";
import { addEntry, getCard, mainLane } from "./store.ts";

export function summonCaptain(db: DatabaseSync, card: number, why: string): string[] {
  const asked = db
    .prepare(
      "SELECT 1 FROM entries WHERE card = ? AND author = 'browser' AND json_extract(fields, '$.summon') = ?",
    )
    .get(card, why);
  if (asked !== undefined) return [];
  const { name } = getCard(db, card);
  const main = mainLane(db);
  const body = `c-${String(card)} ${name} needs the captain in its browser tab: ${why}. The fleet opened the Browser tab in your workspace, where he can see the tab live and click and type in it. Tell him once; the worker continues when he is done.`;
  addEntry(
    db,
    { card, author: "browser", kind: "comment", body, fields: { for: "mate", summon: why } },
    [main],
  );
  return [main];
}

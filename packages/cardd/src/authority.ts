// The captain's authority (spec sections 9.6 and 18): his words, and grants.
import type { DatabaseSync } from "node:sqlite";

/**
 * Throws unless the captain's words are verified. The mate's extension checks
 * chat words against its own session file (source chat). For any other source,
 * the words must be in a captain entry: a board comment, an option click, or an
 * earlier recorded answer.
 */
export function requireCaptainWords(db: DatabaseSync, words: string, source: string): void {
  if (source === "chat") return;
  const squashed = words.replace(/\s+/g, " ").trim();
  const found = db
    .prepare("SELECT 1 FROM entries WHERE author = 'captain' AND instr(body, ?) > 0")
    .get(squashed);
  if (found === undefined) {
    throw new Error(
      "these words are not in the captain's messages or board entries; quote the captain exactly",
    );
  }
}

export interface Grant {
  readonly id: number;
  readonly merge: boolean;
}

/**
 * The grant that applies to a card (spec section 18): its own grant, else its
 * parent card's grant, else a lane grant whose scope matches it. Expired and
 * ended grants do not apply. Grants do not combine: the first match is the grant.
 */
export function effectiveGrant(db: DatabaseSync, card: number, now: number): Grant | undefined {
  const row = db
    .prepare(
      `SELECT g.id AS id, g.merge AS merge FROM grants g JOIN cards c ON c.id = ?1
       WHERE g.ended_at IS NULL AND (g.expires IS NULL OR g.expires > ?2) AND (
         g.card = c.id OR g.card = c.parent OR (g.lane = c.lane
           AND (g.scope_project IS NULL OR g.scope_project = c.project)
           AND (g.scope_branch IS NULL OR g.scope_branch = c.base_branch)))
       ORDER BY CASE WHEN g.card = c.id THEN 0 WHEN g.card IS NOT NULL THEN 1
         WHEN g.scope_project IS NOT NULL THEN 2 ELSE 3 END, g.id DESC
       LIMIT 1`,
    )
    .get(card, now);
  return row === undefined ? undefined : { id: Number(row["id"]), merge: row["merge"] === 1 };
}

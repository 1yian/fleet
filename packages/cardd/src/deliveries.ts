// Delivery records and recovery (spec section 9.4).
import type { DatabaseSync } from "node:sqlite";
import { check, EntrySchema, type Entry } from "@fleet/protocol";
import { ENTRY_JSON, json } from "./store.ts";

export interface Push {
  readonly entry: Entry;
  readonly mode: "steer" | "followUp";
}

/** Marks the entries found in the session file Confirmed. Returns the new low-water mark. */
export function confirm(db: DatabaseSync, session: string, inFile: readonly number[]): number {
  const mark = db.prepare(
    "UPDATE deliveries SET state = 'confirmed', updated_at = ? WHERE session = ? AND entry = ?",
  );
  for (const entry of inFile) mark.run(Date.now(), session, entry);
  const row = db
    .prepare(
      `SELECT coalesce(
         (SELECT min(entry) - 1 FROM deliveries WHERE session = ?1 AND state <> 'confirmed'),
         (SELECT max(entry) FROM deliveries WHERE session = ?1),
         0) AS low`,
    )
    .get(session);
  const low = Number(row?.["low"]);
  db.prepare("UPDATE sessions SET low_water = ? WHERE id = ?").run(low, session);
  return low;
}

/** The entries to push, in entry order: every unconfirmed one at a connect, otherwise the pending ones. */
export function toPush(db: DatabaseSync, session: string, atConnect: boolean): Push[] {
  const states = atConnect ? "('pending', 'pushed', 'acknowledged')" : "('pending')";
  const rows = json(
    db,
    `SELECT ${ENTRY_JSON} AS j FROM deliveries d JOIN entries e ON e.id = d.entry
     WHERE d.session = ? AND d.state IN ${states} ORDER BY e.id`,
    session,
  );
  const pushes = rows.map((row) => {
    const entry = check(EntrySchema, row);
    return { entry, mode: entry.fields["now"] === true ? "steer" : "followUp" } as const;
  });
  const mark = db.prepare(
    "UPDATE deliveries SET state = 'pushed', updated_at = ? WHERE session = ? AND entry = ? AND state = 'pending'",
  );
  for (const { entry } of pushes) mark.run(Date.now(), session, entry.id);
  return pushes;
}

export function acknowledge(db: DatabaseSync, session: string, entry: number): void {
  db.prepare(
    `UPDATE deliveries SET state = 'acknowledged', updated_at = ?
     WHERE session = ? AND entry = ? AND state IN ('pending', 'pushed')`,
  ).run(Date.now(), session, entry);
}

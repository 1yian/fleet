import type { DatabaseSync } from "node:sqlite";

export interface Pause {
  readonly since: number;
  readonly by: string;
  readonly reason: string;
}

export function pauseOf(db: DatabaseSync): Pause | undefined {
  const row = db.prepare("SELECT since, by, reason FROM pause WHERE id = 1").get();
  if (row === undefined) return undefined;
  return { since: Number(row["since"]), by: String(row["by"]), reason: String(row["reason"]) };
}

export function pause(db: DatabaseSync, by: string, reason: string, now: number): Pause {
  db.prepare("INSERT OR IGNORE INTO pause (id, since, by, reason) VALUES (1, ?, ?, ?)").run(
    now,
    by,
    reason,
  );
  const found = pauseOf(db);
  if (found === undefined) throw new Error("the pause was not recorded");
  return found;
}

export function resume(db: DatabaseSync): boolean {
  return db.prepare("DELETE FROM pause WHERE id = 1").run().changes > 0;
}

export function refuseWhilePaused(db: DatabaseSync, what: string): void {
  const found = pauseOf(db);
  if (found === undefined) return;
  const why = found.reason === "" ? "" : `: ${found.reason}`;
  throw new Error(
    `the fleet is paused since ${new Date(found.since).toISOString()} by ${found.by}${why}. No ${what} until the captain runs fleet resume.`,
  );
}

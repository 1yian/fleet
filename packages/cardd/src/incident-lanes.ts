import type { DatabaseSync } from "node:sqlite";
import type { OpArgs } from "@fleet/protocol";
import { liveIncident } from "./incident-store.ts";
import { openIncident } from "./incidents.ts";
import { laneCardOf, parentOf, type Session } from "./store.ts";
import type { Timings } from "./timing.ts";

export function markStopping(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"lane.stopping">,
): { stopping: boolean } {
  if (parentOf(db, args.lane) !== session.lane)
    throw new Error(`lane ${args.lane} is not one of your second mates`);
  db.prepare("UPDATE sessions SET stopping = 1 WHERE id = ? AND role = 'mate'").run(args.lane);
  return { stopping: true };
}

export function lostMates(db: DatabaseSync, now: number, t: Timings): string[] {
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.lane AS lane FROM sessions s JOIN lanes l ON l.name = s.lane
       WHERE s.role = 'mate' AND s.state = 'lost' AND s.stopping = 0 AND l.parent IS NOT NULL
         AND l.card IS NOT NULL AND ?1 - coalesce(s.last_seen, 0) > ?2`,
    )
    .all(now, t.notConnected);
  return rows.flatMap((row) => {
    const id = String(row["id"]);
    const card = laneCardOf(db, String(row["lane"]));
    if (card === undefined || liveIncident(db, id) !== undefined) return [];
    const seen = {
      phase: "lost",
      error: "connection lost with no final event",
      source: "the timed check",
    } as const;
    return openIncident(
      db,
      { id, role: "mate", lane: String(row["lane"]), card },
      seen,
      t.wall(),
      t,
    ).notify;
  });
}

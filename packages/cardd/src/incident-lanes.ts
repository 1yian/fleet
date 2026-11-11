import type { DatabaseSync } from "node:sqlite";
import type { OpArgs } from "@fleet/protocol";
import { liveIncident } from "./incident-store.ts";
import { openIncident } from "./incidents.ts";
import { stopOf, transitionStop, untilOf } from "./lane-stop.ts";
import { laneCardOf, parentOf, type Session } from "./store.ts";
import type { Timings } from "./timing.ts";

export function markStopping(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"lane.stopping">,
  now: number,
  window: number,
): { stopping: boolean } {
  if (parentOf(db, args.lane) !== session.lane)
    throw new Error(`lane ${args.lane} is not one of your second mates`);
  transitionStop(db, args.lane, { event: "mark", now, window });
  return { stopping: true };
}

export function lostMates(db: DatabaseSync, now: number, t: Timings): string[] {
  const wall = t.wall();
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.lane AS lane, s.stopping_until AS until
       FROM sessions s JOIN lanes l ON l.name = s.lane
       WHERE s.role = 'mate' AND s.state = 'lost' AND l.parent IS NOT NULL
         AND l.card IS NOT NULL AND ? - coalesce(s.last_seen, 0) > ?`,
    )
    .all(now, t.notConnected)
    .filter((row) => stopOf(untilOf(row), wall).kind === "up");
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

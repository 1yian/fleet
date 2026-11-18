import type { DatabaseSync } from "node:sqlite";
import type { Entry } from "@fleet/protocol";
import { runningJobSql } from "./jobs.ts";
import type { Loaded } from "./store.ts";
import { SCHEDULE, SCRIPT } from "./wakes.ts";

const MOVEMENT: ReadonlySet<string> = new Set([
  "comment",
  "report",
  "hold",
  "release",
  "answer",
  "review-feedback",
  "cleanup",
]);
const AUTOMATIC: ReadonlySet<string> = new Set([SCHEDULE, SCRIPT]);
const NO_NEWS: ReadonlySet<unknown> = new Set(["working", "note"]);

export interface Run {
  readonly id: number;
  readonly label: string;
  readonly at: number;
  readonly running: boolean;
}

export interface Movement {
  readonly movedAt: number;
  readonly fresh: readonly Run[];
  readonly again: readonly Run[];
}

function progressAt(db: DatabaseSync, card: number): number {
  const at = db
    .prepare(
      `SELECT max(s.progress_at) AS at FROM sessions s JOIN attempts a ON a.id = s.attempt
       WHERE a.card = ?`,
    )
    .get(card)?.["at"];
  return typeof at === "number" ? at : 0;
}

function runsOf(db: DatabaseSync, card: number): Run[] {
  return db
    .prepare(
      `SELECT j.id AS id, j.label AS label, j.created_at AS at, ${runningJobSql("j.state")} AS running
       FROM jobs j JOIN attempts a ON a.id = j.attempt
       WHERE a.card = ? AND a.state IN ('starting', 'active') ORDER BY j.id`,
    )
    .all(card)
    .map((row) => ({
      id: Number(row["id"]),
      label: String(row["label"]),
      at: Number(row["at"]),
      running: row["running"] === 1,
    }));
}

function repeatedReports(entries: readonly Entry[]): ReadonlySet<number> {
  const repeated = new Set<number>();
  let before: unknown;
  for (const entry of entries) {
    if (entry.kind !== "report") continue;
    const status = entry.fields["status"];
    if (NO_NEWS.has(status) && NO_NEWS.has(before)) repeated.add(entry.id);
    before = status;
  }
  return repeated;
}

const changes =
  (repeated: ReadonlySet<number>) =>
  (entry: Entry): boolean =>
    MOVEMENT.has(entry.kind) && !AUTOMATIC.has(entry.author) && !repeated.has(entry.id);

const finishes =
  (again: ReadonlySet<number>) =>
  (entry: Entry): boolean =>
    entry.kind === "job-result" &&
    entry.fields["lost"] !== true &&
    !again.has(Number(entry.fields["job"]));

function startedAgain(runs: readonly Run[], since: number): ReadonlySet<number> {
  const later = runs.filter((run) =>
    runs.some(
      (earlier) => earlier.id < run.id && earlier.label === run.label && earlier.at > since,
    ),
  );
  return new Set(later.map(({ id }) => id));
}

export function movementOf(db: DatabaseSync, { card, entries }: Loaded): Movement {
  const repeated = repeatedReports(entries);
  const changed = entries.findLast(changes(repeated))?.createdAt ?? 0;
  const base = Math.max(card.createdAt, changed, progressAt(db, card.id));
  const runs = runsOf(db, card.id);
  const again = startedAgain(runs, base);
  const finished = entries.findLast(finishes(again))?.createdAt ?? 0;
  const running = runs.filter((run) => run.running);
  return {
    movedAt: Math.max(base, finished),
    fresh: running.filter((run) => !again.has(run.id)),
    again: running.filter((run) => again.has(run.id)),
  };
}

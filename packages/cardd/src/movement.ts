import type { DatabaseSync } from "node:sqlite";
import type { Entry } from "@fleet/protocol";
import { launchedJobSql, runningJobSql } from "./jobs.ts";
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
      `SELECT j.id AS id, j.label AS label, j.created_at AS at, ${runningJobSql("j")} AS running
       FROM jobs j JOIN attempts a ON a.id = j.attempt
       WHERE a.card = ? AND a.state IN ('starting', 'active') AND ${launchedJobSql("j")}
       ORDER BY j.id`,
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
    if (status === "working" && before === "working") repeated.add(entry.id);
    before = status;
  }
  return repeated;
}

const changes =
  (repeated: ReadonlySet<number>) =>
  (entry: Entry): boolean =>
    MOVEMENT.has(entry.kind) && !AUTOMATIC.has(entry.author) && !repeated.has(entry.id);

const noStart = (entry: Entry): boolean =>
  entry.kind === "job-result" &&
  (entry.fields["startupFenced"] === true || entry.fields["commandNotStarted"] === true);

const completion = (entry: Entry): boolean =>
  entry.kind === "job-result" && entry.fields["lost"] !== true && !noStart(entry);

function changedExits(entries: readonly Entry[], runs: readonly Run[]): ReadonlySet<number> {
  const labels = new Map(runs.map((run) => [run.id, run.label]));
  const last = new Map<string, unknown>();
  const differs = new Set<number>();
  for (const entry of entries) {
    const label = labels.get(Number(entry.fields["job"]));
    const code = entry.fields["exitCode"];
    if (label === undefined || typeof code !== "number") continue;
    if (last.has(label) && last.get(label) !== code) differs.add(entry.id);
    last.set(label, code);
  }
  return differs;
}

function startedAgain(runs: readonly Run[], since: number): ReadonlySet<number> {
  const armed = new Set<string>();
  const later = new Set<number>();
  for (const run of runs) {
    if (armed.has(run.label)) later.add(run.id);
    if (run.at > since) armed.add(run.label);
  }
  return later;
}

export function movementOf(db: DatabaseSync, { card, entries }: Loaded): Movement {
  const repeated = repeatedReports(entries);
  const changed = entries.findLast(changes(repeated))?.createdAt ?? 0;
  const base = Math.max(card.createdAt, changed, progressAt(db, card.id));
  const unstarted = new Set(entries.filter(noStart).map((entry) => Number(entry.fields["job"])));
  const runs = runsOf(db, card.id).filter((run) => !unstarted.has(run.id));
  const completions = entries.filter(completion);
  const differs = changedExits(completions, runs);
  const exitAt = completions.findLast((entry) => differs.has(entry.id))?.createdAt ?? 0;
  const again = startedAgain(runs, Math.max(base, exitAt));
  const finished =
    completions.findLast(
      (entry) => !again.has(Number(entry.fields["job"])) || differs.has(entry.id),
    )?.createdAt ?? 0;
  const running = runs.filter((run) => run.running);
  return {
    movedAt: Math.max(base, finished),
    fresh: running.filter((run) => !again.has(run.id)),
    again: running.filter((run) => again.has(run.id)),
  };
}

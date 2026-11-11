import type { DatabaseSync } from "node:sqlite";
import type {
  Activity,
  DatedWait,
  Entry,
  Notice,
  Pulse,
  PulseState,
  Status,
} from "@fleet/protocol";
import { runningJobSql } from "./jobs.ts";
import { activityOf, type Loaded } from "./store.ts";
import type { Timings } from "./timing.ts";
import { SCHEDULE, SCRIPT } from "./wakes.ts";

export interface Neglect {
  readonly now: number;
  readonly timing: Timings;
  readonly main: string | undefined;
  readonly statusOf: (card: number) => Status | undefined;
}

const mainOf = (db: DatabaseSync): string | undefined => {
  const name = db.prepare("SELECT name FROM lanes WHERE parent IS NULL").get()?.["name"];
  return typeof name === "string" ? name : undefined;
};

export const neglectOf = (
  db: DatabaseSync,
  timing: Timings,
  now: number,
  statusOf: Neglect["statusOf"],
): Neglect => ({ now, timing, main: mainOf(db), statusOf });

interface Reading {
  readonly state: PulseState;
  readonly since: number;
}

const MOVEMENT: ReadonlySet<string> = new Set([
  "comment",
  "report",
  "hold",
  "release",
  "answer",
  "review-feedback",
  "job-result",
  "cleanup",
]);
const AUTOMATIC: ReadonlySet<string> = new Set([SCHEDULE, SCRIPT]);
const DOWN: ReadonlySet<string> = new Set(["starting", "exited", "lost"]);
const COVERED: ReadonlySet<DatedWait["watch"]> = new Set(["running", "later"]);
const WORKING: ReadonlySet<Status> = new Set(["working", "in-review"]);
const WITH_WORKER: ReadonlySet<Status> = new Set(["working", "in-review", "merging", "paused"]);

function moves(entry: Entry): boolean {
  if (!MOVEMENT.has(entry.kind) || AUTOMATIC.has(entry.author)) return false;
  return !(entry.kind === "job-result" && entry.fields["lost"] === true);
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

function movedAt(db: DatabaseSync, { card, entries }: Loaded): number {
  const entry = entries.findLast(moves)?.createdAt ?? 0;
  return Math.max(card.createdAt, entry, progressAt(db, card.id));
}

function runningJobs(db: DatabaseSync, card: number): string | undefined {
  const jobs = db
    .prepare(
      `SELECT j.id AS id, j.label AS label FROM jobs j JOIN attempts a ON a.id = j.attempt
       WHERE a.card = ? AND a.state IN ('starting', 'active') AND ${runningJobSql("j.state")}
       ORDER BY j.id`,
    )
    .all(card);
  const [first] = jobs;
  if (first === undefined) return undefined;
  const named = `job ${String(first["id"])} (${String(first["label"])})`;
  return jobs.length === 1 ? named : `${named} and ${String(jobs.length - 1)} more`;
}

function reported(basis: Basis): Reading | undefined {
  const { loaded, env } = basis;
  const { attention, since } = loaded.standing;
  if (attention === null) return undefined;
  const reportAt = loaded.entries.findLast(
    (entry) => entry.kind === "report" && entry.fields["status"] === attention,
  )?.createdAt;
  const at = reportAt ?? since;
  if (attention === "failed") return { state: "broken", since: at };
  return env.now - at >= env.timing.stall ? { state: "stalled", since: at } : undefined;
}

function silent({ loaded, activity, env }: Basis): Reading | undefined {
  if (activity === null || !WORKING.has(loaded.card.status)) return undefined;
  const quiet = env.now - activity.at;
  if (DOWN.has(activity.state) && quiet >= env.timing.notConnected)
    return { state: "broken", since: activity.at };
  if (activity.state === "running" && quiet >= env.timing.stall)
    return { state: "stalled", since: activity.at };
  return undefined;
}

const putOff = ({ wait }: Basis): boolean => wait?.watch === "later";

function needOf(basis: Basis): Reading | undefined {
  const { card, standing } = basis.loaded;
  if (card.status === "needs-you" || (card.kind === "captain" && !putOff(basis)))
    return { state: "you", since: standing.since };
  return reported(basis) ?? silent(basis);
}

function readingOf(basis: Basis): Reading {
  const { loaded, wait, running, moved } = basis;
  const { card, standing } = loaded;
  const need = needOf(basis);
  if (need !== undefined) return need;
  if (running !== null) return { state: "running", since: moved };
  if (wait !== null)
    return { state: COVERED.has(wait.watch) ? "waiting" : "parked", since: wait.since };
  if (card.status === "paused") return { state: "parked", since: standing.since };
  return { state: "idle", since: moved };
}

function noticeOf({ state, since }: Reading, moved: number, env: Neglect): Notice {
  const { now, timing: t } = env;
  if (state === "broken") return "urgent";
  if (state === "stalled") return "captain";
  if (state === "idle") {
    const quiet = now - moved;
    return quiet >= t.idleCaptain ? "captain" : quiet >= t.idleMain ? "main" : "none";
  }
  if (state !== "parked") return "none";
  const held = now - since;
  return held >= t.parkedUrgent ? "urgent" : held >= t.parked ? "captain" : "none";
}

interface Basis {
  readonly loaded: Loaded;
  readonly wait: DatedWait | null;
  readonly activity: Activity | null;
  readonly running: Pulse["running"];
  readonly moved: number;
  readonly env: Neglect;
}

function workerOwner(db: DatabaseSync, { loaded, activity }: Basis): Pulse["owner"] | undefined {
  const { card } = loaded;
  if (activity === null || !WITH_WORKER.has(card.status)) return undefined;
  const row = db
    .prepare(
      `SELECT s.id AS session, a.host AS host FROM attempts a JOIN sessions s ON s.attempt = a.id
       WHERE a.card = ? AND a.state IN ('starting', 'active') AND s.state <> 'closed'`,
    )
    .get(card.id);
  return row === undefined
    ? undefined
    : { kind: "worker", name: String(row["session"]), host: String(row["host"]) };
}

function ownerOf(db: DatabaseSync, basis: Basis): Pulse["owner"] {
  const { card, standing } = basis.loaded;
  const holder = standing.facts.hold?.holder;
  if (card.status === "needs-you" || card.kind === "captain" || holder === "captain")
    return { kind: "captain", name: "captain", host: null };
  const worker = workerOwner(db, basis);
  if (worker !== undefined) return worker;
  const { main } = basis.env;
  if (holder === "main" || card.lane === main)
    return { kind: "main", name: main ?? card.lane, host: null };
  return { kind: "mate", name: card.lane, host: null };
}

function waitsOf(basis: Basis, state: PulseState, owner: Pulse["owner"]): Pulse["waits"] {
  if (state === "you") return "captain";
  if (basis.wait !== null) return "date";
  if (basis.loaded.card.status === "paused") return "pause";
  return owner.kind === "worker" ? "nothing" : owner.kind;
}

export function behindOf(
  remaining: readonly number[],
  statusOf: Neglect["statusOf"],
): Pulse["behind"] {
  const open = remaining.flatMap((step) => {
    const status = statusOf(step);
    return status === undefined || status === "done" || status === "dropped" ? [] : [status];
  });
  if (open.length === 0) return null;
  return { steps: open.length, started: open.filter((status) => status !== "queued").length };
}

export function pulseOf(
  db: DatabaseSync,
  loaded: Loaded,
  wait: DatedWait | null,
  env: Neglect,
): Pulse | null {
  const { card } = loaded;
  if (card.kind === "standing" || card.status === "done" || card.status === "dropped") return null;
  const activity = activityOf(db, card, false);
  const jobs = runningJobs(db, card.id);
  const running: Pulse["running"] =
    activity?.state === "running"
      ? { by: "turn", what: "a turn" }
      : jobs === undefined
        ? null
        : { by: "job", what: jobs };
  const basis = { loaded, wait, activity, running, moved: movedAt(db, loaded), env };
  const reading = readingOf(basis);
  const owner = ownerOf(db, basis);
  return {
    state: reading.state,
    notice: noticeOf(reading, basis.moved, env),
    owner,
    running,
    movedAt: basis.moved,
    since: reading.since,
    waits: waitsOf(basis, reading.state, owner),
    behind: behindOf(loaded.standing.facts.hold?.remaining ?? [], env.statusOf),
  };
}

export function pulsesOf(
  db: DatabaseSync,
  open: readonly Loaded[],
  waits: ReadonlyMap<number, DatedWait>,
  timing: Timings,
  now: number,
): Map<number, Pulse> {
  const statuses = new Map(open.map(({ card }) => [card.id, card.status]));
  const neglect = neglectOf(db, timing, now, (id) => statuses.get(id));
  return new Map(
    open.flatMap((loaded) => {
      const pulse = pulseOf(db, loaded, waits.get(loaded.card.id) ?? null, neglect);
      return pulse === null ? [] : [[loaded.card.id, pulse] as const];
    }),
  );
}

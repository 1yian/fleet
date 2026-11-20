import type { DatabaseSync } from "node:sqlite";
import {
  jobIsRunning,
  nextJob,
  parseJobState,
  startedJob,
  JOB_RUNNING,
  type JobEvent,
  type JobLife,
  type JobState,
} from "@fleet/protocol";

export const jobStateSql = (column: string, state: JobState): string => `${column} = '${state}'`;

export const launchedJobSql = (alias: string): string =>
  `(${alias}.launch_id IS NULL OR ${alias}.wrapper_pid IS NOT NULL)`;

export const runningJobSql = (alias: string): string =>
  `(${jobStateSql(`${alias}.state`, JOB_RUNNING)} AND ${launchedJobSql(alias)})`;

interface StoredJob {
  readonly id: number;
  readonly label: string;
  readonly attempt: number;
  readonly life: JobLife;
}

function numberOf(value: unknown, name: string): number {
  if (typeof value !== "number") throw new Error(`bad ${name}`);
  return value;
}

function textOf(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`bad ${name}`);
  return value;
}

function lifeOf(state: unknown, droppedAt: unknown): JobLife {
  if (droppedAt !== null && typeof droppedAt !== "number") throw new Error("bad dropped_at");
  return { state: parseJobState(state), droppedAt };
}

function readJob(db: DatabaseSync, id: number): (StoredJob & { launched: boolean }) | undefined {
  const row = db
    .prepare(
      `SELECT id, label, attempt, state, dropped_at, ${launchedJobSql("j")} AS launched
       FROM jobs j WHERE id = ?`,
    )
    .get(id);
  if (row === undefined) return undefined;
  return {
    id: numberOf(row["id"], "id"),
    label: textOf(row["label"], "label"),
    attempt: numberOf(row["attempt"], "attempt"),
    life: lifeOf(row["state"], row["dropped_at"]),
    launched: row["launched"] === 1,
  };
}

function attemptOf(db: DatabaseSync, session: string): number {
  const id = db.prepare("SELECT attempt FROM sessions WHERE id = ?").get(session)?.["attempt"];
  if (typeof id !== "number") throw new Error(`${session} is not a worker session`);
  return id;
}

function ownedJob(db: DatabaseSync, session: string, id: number): ReturnType<typeof readJob> {
  const job = readJob(db, id);
  if (job?.attempt !== attemptOf(db, session)) return undefined;
  return job;
}

interface Moved {
  readonly label: string;
  readonly before: JobState;
  readonly life: JobLife;
  readonly revived: boolean;
}

function transitionJob(
  db: DatabaseSync,
  job: StoredJob,
  event: JobEvent,
  at: number,
): Moved | undefined {
  const step = nextJob(job.life, event, at);
  if (step === undefined) return undefined;
  db.prepare(
    "UPDATE jobs SET state = ?, dropped_at = ?, updated_at = ?, exit_code = ?, output_tail = ? WHERE id = ?",
  ).run(step.life.state, step.life.droppedAt, at, step.exitCode, step.outputTail, job.id);
  return { label: job.label, before: job.life.state, life: step.life, revived: step.revived };
}

export function startJob(
  db: DatabaseSync,
  session: string,
  job: { label: string; command: string; launch?: string },
): number {
  const attempt = attemptOf(db, session);
  if (job.launch !== undefined) {
    const reservation = db
      .prepare("SELECT id, attempt, label, command FROM jobs WHERE launch_id = ?")
      .get(job.launch);
    if (reservation !== undefined) {
      if (
        reservation["attempt"] !== attempt ||
        reservation["label"] !== job.label ||
        reservation["command"] !== job.command
      )
        throw new Error("The launch ID is already in use");
      return numberOf(reservation["id"], "id");
    }
  }
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO jobs (attempt, label, command, state, created_at, updated_at, launch_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(attempt, job.label, job.command, startedJob().state, now, now, job.launch ?? null);
  return Number(lastInsertRowid);
}

export function registerJob(
  db: DatabaseSync,
  session: string,
  args: { job: number; launch: string; pid: number },
): boolean {
  const { changes } = db
    .prepare(
      `UPDATE jobs SET wrapper_pid = ?, updated_at = ?
     WHERE id = ? AND attempt = ? AND launch_id = ? AND ${jobStateSql("state", JOB_RUNNING)}
       AND (wrapper_pid IS NULL OR wrapper_pid = ?)`,
    )
    .run(args.pid, Date.now(), args.job, attemptOf(db, session), args.launch, args.pid);
  return changes === 1;
}

export function finishJob(
  db: DatabaseSync,
  session: string,
  job: { id: number; exitCode: number; outputTail: string; beforeRegistration?: string },
): { label: string } | undefined {
  const owned = ownedJob(db, session, job.id);
  if (owned === undefined) return undefined;
  if (
    job.beforeRegistration !== undefined &&
    db
      .prepare("SELECT id FROM jobs WHERE id = ? AND launch_id = ? AND wrapper_pid IS NULL")
      .get(job.id, job.beforeRegistration) === undefined
  )
    return undefined;
  const moved = transitionJob(
    db,
    owned,
    { name: "finish", exitCode: job.exitCode, outputTail: job.outputTail },
    Date.now(),
  );
  if (moved === undefined) return undefined;
  return { label: moved.label };
}

export function touchJob(
  db: DatabaseSync,
  session: string,
  job: number,
): { running: boolean; revived?: { label: string } } {
  const owned = ownedJob(db, session, job);
  if (owned?.launched !== true) return { running: false };
  const moved = transitionJob(db, owned, { name: "alive" }, Date.now());
  if (moved === undefined || !jobIsRunning(moved.life.state)) return { running: false };
  if (moved.revived) return { running: true, revived: { label: moved.label } };
  return { running: true };
}

export function ownJob(
  db: DatabaseSync,
  session: string,
  job: number,
): { label: string; running: boolean } | undefined {
  const owned = ownedJob(db, session, job);
  if (owned === undefined) return undefined;
  return { label: owned.label, running: owned.launched && jobIsRunning(owned.life.state) };
}

export function dropLostJob(
  db: DatabaseSync,
  job: number,
  owner: { session: string } | { lane: string },
): { label: string; dropped: boolean; state: JobState } | undefined {
  const row = db
    .prepare(
      `SELECT j.label AS label, j.state AS state, j.dropped_at AS dropped_at, j.attempt AS attempt, c.lane AS lane
       FROM jobs j JOIN attempts a ON a.id = j.attempt JOIN cards c ON c.id = a.card WHERE j.id = ?`,
    )
    .get(job);
  if (row === undefined) return undefined;
  const attempt = numberOf(row["attempt"], "attempt");
  const owned =
    "session" in owner ? attempt === attemptOf(db, owner.session) : row["lane"] === owner.lane;
  if (!owned) return undefined;
  const stored: StoredJob = {
    id: job,
    label: textOf(row["label"], "label"),
    attempt,
    life: lifeOf(row["state"], row["dropped_at"]),
  };
  const moved = transitionJob(db, stored, { name: "drop" }, Date.now());
  if (moved === undefined) return { label: stored.label, state: stored.life.state, dropped: false };
  return { label: moved.label, state: moved.life.state, dropped: true };
}

export function loseSilentJobs(
  db: DatabaseSync,
  before: number,
): { id: number; label: string; card: number }[] {
  const silent = db
    .prepare(
      `SELECT j.id AS id, j.label AS label, a.card AS card FROM jobs j JOIN attempts a ON a.id = j.attempt
       WHERE ${runningJobSql("j")}
         AND j.updated_at < ? AND a.state IN ('starting', 'active')
       ORDER BY j.id`,
    )
    .all(before);
  const lost: { id: number; label: string; card: number }[] = [];
  const at = Date.now();
  for (const row of silent) {
    const job = readJob(db, numberOf(row["id"], "id"));
    if (job === undefined) continue;
    if (transitionJob(db, job, { name: "lose" }, at) === undefined) continue;
    lost.push({
      id: job.id,
      label: job.label,
      card: numberOf(row["card"], "card"),
    });
  }
  return lost;
}

export function abandonRunningJobs(db: DatabaseSync, card: number, at: number): void {
  const ids = db
    .prepare(
      `SELECT j.id AS id FROM jobs j JOIN attempts a ON a.id = j.attempt
       WHERE a.card = ? AND a.state IN ('starting', 'active') AND ${jobStateSql("j.state", JOB_RUNNING)}
       ORDER BY j.id`,
    )
    .all(card);
  for (const row of ids) {
    const job = readJob(db, numberOf(row["id"], "id"));
    if (job === undefined) continue;
    if (transitionJob(db, job, { name: "abandon" }, at) === undefined)
      throw new Error(`job ${String(job.id)} stayed running as its attempt ended`);
  }
}

export function runningJobs(db: DatabaseSync, session: string): { id: number; label: string }[] {
  return db
    .prepare(
      `SELECT id, label FROM jobs j
       WHERE attempt = ? AND ${runningJobSql("j")} ORDER BY id`,
    )
    .all(attemptOf(db, session))
    .map((row) => ({ id: numberOf(row["id"], "id"), label: textOf(row["label"], "label") }));
}

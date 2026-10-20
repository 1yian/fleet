// Attempts and jobs (spec sections 6.9, 6.10, and 11.2). An attempt is one run
// of a card by one worker. Its ID is the retry key for dispatch.
import type { DatabaseSync } from "node:sqlite";
import type { Card } from "@fleet/protocol";
import { addEntry, hash, tokenFor } from "./store.ts";

interface LiveAttempt {
  readonly id: number;
  readonly n: number;
  readonly state: "starting" | "active";
  readonly host: string;
}

const name = (card: number, n: number): string => `c-${String(card)}-a${String(n)}`;

function liveAttempt(db: DatabaseSync, card: number): LiveAttempt | undefined {
  const row = db
    .prepare(
      "SELECT id, n, state, host FROM attempts WHERE card = ? AND state IN ('starting', 'active')",
    )
    .get(card);
  if (row === undefined) return undefined;
  const { id, n, state, host } = row;
  if (typeof id !== "number" || typeof n !== "number" || typeof host !== "string")
    throw new Error("bad attempt row");
  if (state !== "starting" && state !== "active") throw new Error("bad attempt state");
  return { id, n, state, host };
}

function checkCapacity(db: DatabaseSync, card: Card): void {
  if (card.project === null) return;
  const row = db
    .prepare(
      `SELECT p.capacity AS capacity, (SELECT count(*) FROM attempts a JOIN cards c ON c.id = a.card
         WHERE c.project = p.name AND a.state IN ('starting', 'active')) AS used
       FROM projects p WHERE p.name = ?`,
    )
    .get(card.project);
  if (row === undefined) throw new Error(`project ${card.project} is not in the registry`);
  if (Number(row["used"]) >= Number(row["capacity"])) {
    throw new Error(`project ${card.project} is at capacity (${String(row["capacity"])} workers)`);
  }
}

function endAttempt(db: DatabaseSync, attempt: LiveAttempt, state: "ended" | "replaced"): void {
  db.prepare("UPDATE attempts SET state = ?, updated_at = ? WHERE id = ?").run(
    state,
    Date.now(),
    attempt.id,
  );
  db.prepare("UPDATE sessions SET state = 'closed' WHERE attempt = ?").run(attempt.id);
}

export interface Begun {
  readonly session: string;
  readonly token: string;
  readonly resumed: boolean;
  readonly active: boolean;
  readonly clone: string;
  readonly base: string;
  readonly branch: string;
}

/** Where the attempt runs on the host: the project clone, the base branch, and the task branch. */
function placeOf(
  db: DatabaseSync,
  card: Card,
  host: string,
  session: string,
): Pick<Begun, "clone" | "base" | "branch"> {
  if (card.project === null)
    throw new Error(`c-${String(card.id)} has no project, so it cannot be dispatched`);
  const row = db
    .prepare(
      `SELECT json_extract(p.clones, '$.' || ?) AS clone, coalesce(c.base_branch, p.default_base) AS base,
         p.branch_prefix AS prefix
       FROM cards c JOIN projects p ON p.name = c.project WHERE c.id = ?`,
    )
    .get(host, card.id);
  const clone = row?.["clone"];
  if (typeof clone !== "string") throw new Error(`project ${card.project} has no clone on ${host}`);
  return { clone, base: String(row?.["base"]), branch: `${String(row?.["prefix"])}${session}` };
}

/**
 * Starts an attempt, or finds the one a lost dispatch already started on the same
 * host: same session, same token, and no second task message. With replace, the
 * live attempt becomes Replaced and its token stops working. A new attempt gets
 * its task message in the same transaction, so a retry can neither lose it nor repeat it.
 */
export function beginAttempt(
  db: DatabaseSync,
  card: Card,
  request: { host: string; replace: boolean; task: string },
): Begun {
  const live = liveAttempt(db, card.id);
  if (live !== undefined && !request.replace) {
    const session = name(card.id, live.n);
    if (live.host !== request.host) {
      const which = live.state === "active" ? "an active" : "a starting";
      throw new Error(`c-${String(card.id)} has ${which} attempt ${session} on ${live.host}`);
    }
    const place = placeOf(db, card, request.host, session);
    return {
      session,
      token: tokenFor(db, "worker", session),
      resumed: true,
      active: live.state === "active",
      ...place,
    };
  }
  if (live !== undefined) endAttempt(db, live, "replaced");
  checkCapacity(db, card);
  const now = Date.now();
  const n = Number(
    db.prepare("SELECT count(*) + 1 AS n FROM attempts WHERE card = ?").get(card.id)?.["n"],
  );
  const session = name(card.id, n);
  const place = placeOf(db, card, request.host, session);
  const token = tokenFor(db, "worker", session);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO attempts (card, n, host, state, branch, created_at, updated_at)
       VALUES (?, ?, ?, 'starting', ?, ?, ?)`,
    )
    .run(card.id, n, request.host, place.branch, now, now);
  db.prepare(
    `INSERT INTO sessions (id, role, lane, attempt, host, token_hash, state)
     VALUES (?, 'worker', ?, ?, ?, ?, 'starting')`,
  ).run(session, card.lane, lastInsertRowid, request.host, hash(token));
  const task = {
    card: card.id,
    author: `mate:${card.lane}`,
    kind: "comment",
    body: request.task,
    fields: { task: true },
  };
  addEntry(db, task, [session]);
  return { session, token, resumed: false, active: false, ...place };
}

/** The attempt behind a worker session. */
function attemptOf(db: DatabaseSync, session: string): number {
  const id = db.prepare("SELECT attempt FROM sessions WHERE id = ?").get(session)?.["attempt"];
  if (typeof id !== "number") throw new Error(`${session} is not a worker session`);
  return id;
}

export function startJob(
  db: DatabaseSync,
  session: string,
  label: string,
  command: string,
): number {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO jobs (attempt, label, command, state, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)",
    )
    .run(attemptOf(db, session), label, command, now, now);
  return Number(lastInsertRowid);
}

/** Records a job's result once. Returns its label, or undefined if it had already finished. */
export function finishJob(
  db: DatabaseSync,
  session: string,
  job: { id: number; exitCode: number; outputTail: string },
): string | undefined {
  const row = db
    .prepare(
      `UPDATE jobs SET state = 'finished', exit_code = ?, output_tail = ?, updated_at = ?
       WHERE id = ? AND attempt = ? AND state = 'running' RETURNING label`,
    )
    .get(job.exitCode, job.outputTail, Date.now(), job.id, attemptOf(db, session));
  const label = row?.["label"];
  return typeof label === "string" ? label : undefined;
}

export function runningJobs(db: DatabaseSync, session: string): { id: number; label: string }[] {
  return db
    .prepare("SELECT id, label FROM jobs WHERE attempt = ? AND state = 'running' ORDER BY id")
    .all(attemptOf(db, session))
    .map((row) => ({ id: Number(row["id"]), label: String(row["label"]) }));
}

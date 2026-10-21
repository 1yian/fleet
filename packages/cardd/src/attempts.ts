import type { DatabaseSync } from "node:sqlite";
import { check, type Card, type CardView } from "@fleet/protocol";
import Type from "typebox";
import { addEntry, hash, json, tokenFor } from "./store.ts";

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

function endAttempt(db: DatabaseSync, attempt: LiveAttempt, state: "ended" | "replaced"): void {
  db.prepare("UPDATE attempts SET state = ?, updated_at = ? WHERE id = ?").run(
    state,
    Date.now(),
    attempt.id,
  );
  db.prepare("UPDATE sessions SET state = 'closed' WHERE attempt = ?").run(attempt.id);
}

const AttemptsSchema = Type.Array(
  Type.Object({
    n: Type.Integer(),
    host: Type.String(),
    state: Type.String(),
    branch: Type.Union([Type.String(), Type.Null()]),
  }),
);

export const attemptsOf = (db: DatabaseSync, card: number): CardView["attempts"] =>
  check(
    AttemptsSchema,
    json(
      db,
      `SELECT json_object('n', n, 'host', host, 'state', state, 'branch', branch) AS j
       FROM attempts WHERE card = ? ORDER BY n DESC`,
      card,
    ),
  );

export interface Begun {
  readonly session: string;
  readonly token: string;
  readonly resumed: boolean;
  readonly active: boolean;
  readonly connected: boolean;
  readonly clone: string;
  readonly base: string;
  readonly branch: string;
  readonly name: string;
  readonly lane: string;
}

function placeOf(
  db: DatabaseSync,
  card: Card,
  host: string,
  session: string,
): Pick<Begun, "clone" | "base" | "branch" | "name" | "lane"> {
  if (card.project === null)
    throw new Error(`c-${String(card.id)} has no project, so it cannot be dispatched`);
  const row = db
    .prepare(
      `SELECT json_extract(p.clones, '$."' || ? || '"') AS clone, coalesce(c.base_branch, p.default_base) AS base,
         p.branch_prefix AS prefix
       FROM cards c JOIN projects p ON p.name = c.project WHERE c.id = ?`,
    )
    .get(host, card.id);
  const clone = row?.["clone"];
  if (typeof clone !== "string") throw new Error(`project ${card.project} has no clone on ${host}`);
  const branch = `${String(row?.["prefix"])}${session}`;
  return { clone, base: String(row?.["base"]), branch, name: card.name, lane: card.lane };
}

function connected(db: DatabaseSync, session: string): boolean {
  const state = db.prepare("SELECT state FROM sessions WHERE id = ?").get(session)?.["state"];
  return state === "idle" || state === "running" || state === "waiting";
}

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
      connected: connected(db, session),
      ...place,
    };
  }
  if (live !== undefined) endAttempt(db, live, "replaced");
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
  return { session, token, resumed: false, active: false, connected: false, ...place };
}

function attemptOf(db: DatabaseSync, session: string): number {
  const id = db.prepare("SELECT attempt FROM sessions WHERE id = ?").get(session)?.["attempt"];
  if (typeof id !== "number") throw new Error(`${session} is not a worker session`);
  return id;
}

export function startJob(
  db: DatabaseSync,
  session: string,
  job: { label: string; command: string; review: boolean },
): { id: number; key: string | null } {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO jobs (attempt, label, command, state, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)",
    )
    .run(attemptOf(db, session), job.label, job.command, now, now);
  const id = Number(lastInsertRowid);
  if (!job.review) return { id, key: null };
  const key = `review-${String(id)}`;
  db.prepare("UPDATE jobs SET resolves = ? WHERE id = ?").run(key, id);
  return { id, key };
}

export function finishJob(
  db: DatabaseSync,
  session: string,
  job: { id: number; exitCode: number; outputTail: string },
): { label: string; resolves: string | null } | undefined {
  const row = db
    .prepare(
      `UPDATE jobs SET state = 'finished', exit_code = ?, output_tail = ?, updated_at = ?
       WHERE id = ? AND attempt = ? AND state IN ('running', 'lost') RETURNING label, resolves`,
    )
    .get(job.exitCode, job.outputTail, Date.now(), job.id, attemptOf(db, session));
  const label = row?.["label"];
  const resolves = row?.["resolves"];
  if (typeof label !== "string") return undefined;
  return { label, resolves: typeof resolves === "string" ? resolves : null };
}

export function touchJob(db: DatabaseSync, session: string, job: number): boolean {
  const row = db
    .prepare(
      "UPDATE jobs SET updated_at = ? WHERE id = ? AND attempt = ? AND state = 'running' RETURNING id",
    )
    .get(Date.now(), job, attemptOf(db, session));
  return row !== undefined;
}

export function loseSilentJobs(
  db: DatabaseSync,
  before: number,
): { id: number; label: string; card: number }[] {
  const silent = db
    .prepare(
      `SELECT j.id AS id, j.label AS label, a.card AS card FROM jobs j JOIN attempts a ON a.id = j.attempt
       WHERE j.state = 'running' AND j.updated_at < ? AND a.state IN ('starting', 'active')
       ORDER BY j.id`,
    )
    .all(before)
    .map((row) => ({
      id: Number(row["id"]),
      label: String(row["label"]),
      card: Number(row["card"]),
    }));
  const lose = db.prepare("UPDATE jobs SET state = 'lost', updated_at = ? WHERE id = ?");
  for (const job of silent) lose.run(Date.now(), job.id);
  return silent;
}

export function runningJobs(db: DatabaseSync, session: string): { id: number; label: string }[] {
  return db
    .prepare("SELECT id, label FROM jobs WHERE attempt = ? AND state = 'running' ORDER BY id")
    .all(attemptOf(db, session))
    .map((row) => ({ id: Number(row["id"]), label: String(row["label"]) }));
}

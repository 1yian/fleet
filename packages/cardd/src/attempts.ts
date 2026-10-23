import type { DatabaseSync } from "node:sqlite";
import { branchNameProblem, check, type Card, type CardView, type Delivery } from "@fleet/protocol";
import Type from "typebox";
import { requireOpen } from "./change.ts";
import {
  addEntry,
  getCard,
  hash,
  json,
  registeredDelivery,
  tokenFor,
  transaction,
} from "./store.ts";

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

function recordedBranch(db: DatabaseSync, card: number, n: number): string | undefined {
  const branch = db.prepare("SELECT branch FROM attempts WHERE card = ? AND n = ?").get(card, n)?.[
    "branch"
  ];
  return typeof branch === "string" ? branch : undefined;
}

interface BranchRow {
  readonly id: number;
  readonly branch: string;
  readonly named: boolean;
  readonly project: string | null;
}

function branchRow(db: DatabaseSync, session: string): BranchRow {
  const row = db
    .prepare(
      `SELECT a.id AS id, a.branch AS branch, a.branch_named AS named, c.project AS project
       FROM sessions s JOIN attempts a ON a.id = s.attempt JOIN cards c ON c.id = a.card
       WHERE s.id = ?`,
    )
    .get(session);
  const { id, branch, named, project } = row ?? {};
  if (typeof id !== "number" || typeof branch !== "string")
    throw new Error(`${session} has no branch to name`);
  return { id, branch, named: named === 1, project: typeof project === "string" ? project : null };
}

function requireUnclaimed(db: DatabaseSync, row: BranchRow, name: string): void {
  const taken = db
    .prepare(
      `SELECT c.id AS card FROM attempts a JOIN cards c ON c.id = a.card
       WHERE a.id != ? AND a.branch = ? AND a.state IN ('starting', 'active') AND c.project IS ?`,
    )
    .get(row.id, name, row.project);
  if (taken !== undefined)
    throw new Error(`branch ${name} is already the branch of c-${String(taken["card"])}`);
}

export function nameBranch(
  db: DatabaseSync,
  session: string,
  name: string,
): { branch: string; previous: string } {
  const problem = branchNameProblem(name);
  if (problem !== undefined) throw new Error(problem);
  const row = branchRow(db, session);
  const previous = row.branch;
  if (row.named) {
    if (previous === name) return { branch: name, previous };
    throw new Error(
      `${session} already has its branch ${previous}. Keep working on it: a branch is named once`,
    );
  }
  requireUnclaimed(db, row, name);
  db.prepare("UPDATE attempts SET branch = ?, branch_named = 1, updated_at = ? WHERE id = ?").run(
    name,
    Date.now(),
    row.id,
  );
  return { branch: name, previous };
}

export function localLanding(
  db: DatabaseSync,
  card: number,
): { branch: string; base: string } | undefined {
  const row = db
    .prepare(
      `SELECT a.branch AS branch, coalesce(c.base_branch, p.default_base) AS base
       FROM cards c JOIN projects p ON p.name = c.project JOIN attempts a ON a.card = c.id
       WHERE c.id = ? AND c.delivery = 'local-only' AND a.branch IS NOT NULL
       ORDER BY a.n DESC LIMIT 1`,
    )
    .get(card);
  const branch = row?.["branch"];
  const base = row?.["base"];
  return typeof branch === "string" && typeof base === "string" ? { branch, base } : undefined;
}

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
  readonly delivery: Delivery | null;
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

function deliveryOf(db: DatabaseSync, card: Card, asked: Delivery | undefined): Delivery | null {
  if (card.kind !== "ship") {
    if (asked === undefined) return null;
    throw new Error(
      `c-${String(card.id)} is a ${card.kind} card: only a ship card has a delivery mode`,
    );
  }
  const registered = card.project === null ? null : registeredDelivery(db, card.project);
  const mode = asked ?? card.delivery ?? registered;
  db.prepare("UPDATE cards SET delivery = ? WHERE id = ? AND delivery IS NOT ?").run(
    mode,
    card.id,
    mode,
  );
  return mode;
}

export function setCardDelivery(db: DatabaseSync, id: number, mode: Delivery): string {
  return transaction(db, () => {
    const card = getCard(db, id);
    requireOpen(db, card);
    if (card.kind !== "ship")
      throw new Error(
        `c-${String(id)} is a ${card.kind} card: only a ship card has a delivery mode`,
      );
    const live = liveAttempt(db, id);
    if (live !== undefined && card.delivery !== mode)
      throw new Error(
        `c-${String(id)} has a live worker ${name(id, live.n)} running with Delivery: ${String(card.delivery)}. A running card keeps its delivery mode; create new work with dispatch for a different mode`,
      );
    if (card.delivery === mode) return `c-${String(id)}: delivery is already ${mode}`;
    db.prepare("UPDATE cards SET delivery = ? WHERE id = ?").run(mode, id);
    const body = `delivery changed from ${String(card.delivery)} to ${mode}`;
    addEntry(db, { card: id, author: "cardd", kind: "note", body, fields: {} }, []);
    return `c-${String(id)}: delivery ${String(card.delivery)} -> ${mode}`;
  });
}

const DELIVERY_LINE = /^Delivery:\s*(\S+)/m;

function taskWithDelivery(card: Card, task: string, delivery: Delivery | null): string {
  const mode = delivery ?? "report";
  const named = DELIVERY_LINE.exec(task)?.[1];
  if (named === undefined) return `${task.trimEnd()}\n\nDelivery: ${mode}`;
  if (named === mode) return task;
  throw new Error(
    `the task says Delivery: ${named}, but c-${String(card.id)} delivers ${mode}. Leave the Delivery line out, since dispatch adds it from the card, or pass delivery="${named}" to dispatch when the captain asked for that mode`,
  );
}

export const quietSql = (state: string, attempt: string): string =>
  `(${state} = 'idle' OR (${state} = 'waiting'
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.attempt = ${attempt} AND j.state = 'running')))`;

function connected(db: DatabaseSync, session: string): boolean {
  const state = db.prepare("SELECT state FROM sessions WHERE id = ?").get(session)?.["state"];
  return state === "idle" || state === "running" || state === "waiting";
}

export function beginAttempt(
  db: DatabaseSync,
  card: Card,
  request: { host: string; task: string; delivery?: Delivery | undefined },
): Begun {
  const live = liveAttempt(db, card.id);
  if (live !== undefined) {
    if (live.host !== request.host)
      throw new Error(`c-${String(card.id)} already has work on ${live.host}: use restart_card`);
    if (request.delivery !== undefined && request.delivery !== card.delivery)
      throw new Error("a running card keeps its delivery mode");
    return resumeAttempt(db, card);
  }
  const delivery = deliveryOf(db, card, request.delivery);
  const now = Date.now();
  const n = Number(
    db.prepare("SELECT count(*) + 1 AS n FROM attempts WHERE card = ?").get(card.id)?.["n"],
  );
  const session = name(card.id, n);
  const place = placeOf(db, card, request.host, session);
  const body = taskWithDelivery(card, request.task, delivery);
  const token = tokenFor(db, "worker", session);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO attempts (card, n, host, state, branch, branch_named, created_at, updated_at)
       VALUES (?, ?, ?, 'starting', ?, 0, ?, ?)`,
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
    body,
    fields: { task: true },
  };
  addEntry(db, task, [session]);
  return { session, token, resumed: false, active: false, connected: false, ...place, delivery };
}

export function resumeAttempt(db: DatabaseSync, card: Card): Begun {
  const live = liveAttempt(db, card.id);
  if (live === undefined) throw new Error(`c-${String(card.id)} has no live attempt to restart`);
  const session = name(card.id, live.n);
  const place = placeOf(db, card, live.host, session);
  return {
    session,
    token: tokenFor(db, "worker", session),
    resumed: true,
    active: live.state === "active",
    connected: connected(db, session),
    ...place,
    branch: recordedBranch(db, card.id, live.n) ?? place.branch,
    delivery: card.delivery,
  };
}

function attemptOf(db: DatabaseSync, session: string): number {
  const id = db.prepare("SELECT attempt FROM sessions WHERE id = ?").get(session)?.["attempt"];
  if (typeof id !== "number") throw new Error(`${session} is not a worker session`);
  return id;
}

export function startJob(
  db: DatabaseSync,
  session: string,
  job: { label: string; command: string },
): number {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO jobs (attempt, label, command, state, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)",
    )
    .run(attemptOf(db, session), job.label, job.command, now, now);
  return Number(lastInsertRowid);
}

export function finishJob(
  db: DatabaseSync,
  session: string,
  job: { id: number; exitCode: number; outputTail: string },
): { label: string } | undefined {
  const row = db
    .prepare(
      `UPDATE jobs SET state = 'finished', exit_code = ?, output_tail = ?, updated_at = ?
       WHERE id = ? AND attempt = ? AND state IN ('running', 'lost') RETURNING label`,
    )
    .get(job.exitCode, job.outputTail, Date.now(), job.id, attemptOf(db, session));
  const label = row?.["label"];
  if (typeof label !== "string") return undefined;
  return { label };
}

export function touchJob(db: DatabaseSync, session: string, job: number): boolean {
  const row = db
    .prepare(
      "UPDATE jobs SET updated_at = ? WHERE id = ? AND attempt = ? AND state = 'running' RETURNING id",
    )
    .get(Date.now(), job, attemptOf(db, session));
  return row !== undefined;
}

export function ownJob(
  db: DatabaseSync,
  session: string,
  job: number,
): { label: string; running: boolean } | undefined {
  const row = db
    .prepare("SELECT label, state FROM jobs WHERE id = ? AND attempt = ?")
    .get(job, attemptOf(db, session));
  if (row === undefined) return undefined;
  return {
    label: String(row["label"]),
    running: row["state"] === "running",
  };
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

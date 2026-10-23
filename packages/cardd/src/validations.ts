import type { DatabaseSync } from "node:sqlite";
import type { OpArgs } from "@fleet/protocol";
import { generationOf } from "./incident-store.ts";
import { sanitize } from "./incident-kinds.ts";
import { classifyRun } from "./validation-kinds.ts";
import { addEntry, getCard, workerOf, type Session } from "./store.ts";

const MAX_REVALIDATIONS = 3;

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

interface Validation {
  readonly id: number;
  readonly card: number;
  readonly actor: string;
  readonly parent: string | null;
  readonly launch: string;
  readonly run: string | null;
  readonly state: string;
  readonly classification: string | null;
  readonly error: string | null;
  readonly recoveryKey: string | null;
  readonly generation: number;
}

const OPEN: ReadonlySet<string> = new Set(["launching", "running"]);
const FAILED: ReadonlySet<string> = new Set(["failed", "unavailable"]);
const FINISHED: ReadonlySet<string> = new Set(["passed", "cancelled", "failed", "unavailable"]);

function validationFrom(row: Record<string, unknown>): Validation {
  const text = (key: string): string | null => {
    const value = row[key];
    return typeof value === "string" ? value : null;
  };
  return {
    id: Number(row["id"]),
    card: Number(row["card"]),
    actor: String(row["actor"]),
    parent: text("parent"),
    launch: String(row["launch"]),
    run: text("run"),
    state: String(row["state"]),
    classification: text("classification"),
    error: text("error"),
    recoveryKey: text("recovery_key"),
    generation: Number(row["generation"]),
  };
}

function byId(db: DatabaseSync, id: number): Validation {
  const row = db.prepare("SELECT * FROM validations WHERE id = ?").get(id);
  if (row === undefined) throw new Error(`no validation ${String(id)}`);
  return validationFrom(row);
}

function latestOf(db: DatabaseSync, card: number): Validation | undefined {
  const row = db.prepare("SELECT * FROM validations WHERE card = ? ORDER BY id DESC").get(card);
  return row === undefined ? undefined : validationFrom(row);
}

function cardOf(session: Session): number {
  if (session.card === null) throw new Error("only a worker on a card can validate");
  return session.card;
}

function insert(
  db: DatabaseSync,
  session: Session,
  card: number,
  fields: { launch: string | undefined; previous: number | null; key: string | null },
): Validation {
  const attempt = db.prepare("SELECT attempt FROM sessions WHERE id = ?").get(session.id);
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO validations (card, attempt, actor, parent, launch, state, previous, recovery_key,
         generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'launching', ?, ?, ?, ?, ?)`,
    )
    .run(
      card,
      Number(attempt?.["attempt"]),
      session.id,
      session.lane,
      fields.launch ?? "",
      fields.previous,
      fields.key,
      generationOf(db, session.id),
      now,
      now,
    );
  const id = Number(lastInsertRowid);
  if (fields.launch === undefined)
    db.prepare("UPDATE validations SET launch = ? WHERE id = ?").run(
      `c${String(card)}-a${String(attempt?.["attempt"])}-v${String(id)}`,
      id,
    );
  return byId(db, id);
}

function intentFor(db: DatabaseSync, card: number, given: string | undefined): string {
  const own = getCard(db, card).intent;
  const intent = own.trim() === "" ? given : own;
  if (intent === undefined || intent.trim() === "")
    throw new Error(
      "the card has no intent text: pass intent with the captain's words from your task",
    );
  return intent;
}

function openGateLaunch(latest: Validation | undefined): string {
  if (latest?.state !== "gated") throw new Error("the run has no open gate to answer");
  return latest.launch;
}

export function startValidation(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"validation.start">,
): Done {
  const card = cardOf(session);
  const intent = intentFor(db, card, args.intent);
  const latest = latestOf(db, card);
  const answering = args.respond !== undefined || args.answer !== undefined;
  if (latest !== undefined && OPEN.has(latest.state)) {
    if (answering)
      throw new Error(
        `validation ${String(latest.id)} is still driving its run: wait for its gate or outcome`,
      );
    return {
      value: { validation: latest.id, nonce: latest.launch, intent, reused: true },
      notify: [],
    };
  }
  const launch = answering ? openGateLaunch(latest) : undefined;
  const made = insert(db, session, card, { launch, previous: null, key: null });
  return { value: { validation: made.id, nonce: made.launch, intent, reused: false }, notify: [] };
}

function noticeFor(db: DatabaseSync, row: Validation, error: string, klass: string): string {
  const used = revalidationsOf(db, row.card);
  const run = row.run === null ? "no run was started" : `run ${row.run}`;
  const refusal = klass === "refusal" ? " A rerun repeats a refusal: the worker acts on it." : "";
  const next =
    used >= MAX_REVALIDATIONS
      ? `All ${String(MAX_REVALIDATIONS)} revalidations of this card are spent: it needs intervention.`
      : `Reply with revalidate(validation=${String(row.id)}, generation=${String(row.generation)}) to rerun it on the same card, branch, and PR (${String(used)} of ${String(MAX_REVALIDATIONS)} used). Fleet does not rerun by itself.${refusal}`;
  const where = klass === "daemon-down" ? " Fleet does not start or restart the daemon." : "";
  return `validation failed: the no-mistakes pipeline of c-${String(row.card)} stopped (${run}, validation ${String(row.id)}). Class: ${klass}. Error: ${error}.${where} ${next}`;
}

function revalidationsOf(db: DatabaseSync, card: number): number {
  return Number(
    db
      .prepare("SELECT count(*) AS n FROM validations WHERE card = ? AND previous IS NOT NULL")
      .get(card)?.["n"],
  );
}

function alreadyTold(db: DatabaseSync, row: Validation): boolean {
  if (row.run === null) return false;
  return (
    db
      .prepare("SELECT 1 FROM validations WHERE run = ? AND told_at IS NOT NULL AND id <> ?")
      .get(row.run, row.id) !== undefined
  );
}

function isNews(row: Validation, args: OpArgs<"validation.result">): boolean {
  const learnsRun = args.state === "running" && row.run === null && args.run !== undefined;
  return !FINISHED.has(row.state) && (row.state !== args.state || learnsRun);
}

function noteFailure(db: DatabaseSync, row: Validation, klass: string, error: string): void {
  if (row.parent === null) return;
  const after = byId(db, row.id);
  const fields = {
    condition: "validation-failed",
    validation: row.id,
    run: after.run,
    class: klass,
    generation: row.generation,
  };
  const body = noticeFor(db, after, error, klass);
  addEntry(db, { card: row.card, author: "check", kind: "finding", body, fields }, [row.parent]);
}

function store(
  db: DatabaseSync,
  row: Validation,
  args: OpArgs<"validation.result">,
  seen: { error: string | null; klass: string | null; told: boolean },
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE validations SET state = ?, run = coalesce(?, run), outcome = ?, error = ?,
       classification = ?, told_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    args.state,
    args.run ?? null,
    args.outcome ?? null,
    seen.error,
    seen.klass,
    seen.told ? now : null,
    now,
    row.id,
  );
}

export function recordValidation(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"validation.result">,
): Done {
  const row = byId(db, args.validation);
  if (row.card !== session.card)
    throw new Error(`validation ${String(row.id)} is not one of this worker's`);
  if (!isNews(row, args)) return { value: { recorded: false, told: false }, notify: [] };
  const error = sanitize(args.error ?? "");
  const klass = FAILED.has(args.state) ? classifyRun(args.state, error) : null;
  const told = klass !== null && !alreadyTold(db, row);
  store(db, row, args, { error: error === "" ? null : error, klass, told });
  if (!told || row.parent === null) return { value: { recorded: true, told: false }, notify: [] };
  noteFailure(db, row, klass, error === "" ? "no error text" : error);
  return { value: { recorded: true, told: true }, notify: [row.parent] };
}

function requireRevalidable(
  db: DatabaseSync,
  row: Validation,
  args: OpArgs<"validation.revalidate">,
): void {
  const current = generationOf(db, row.actor);
  if (args.generation !== current)
    throw new Error(
      `validation ${String(row.id)} names process generation ${String(args.generation)}, but the worker is on ${String(current)}: name ${String(current)} to revalidate`,
    );
  if (!FAILED.has(row.state))
    throw new Error(`validation ${String(row.id)} is ${row.state}: only a failed run is rerun`);
  const status = getCard(db, row.card).status;
  if (status === "done" || status === "dropped" || status === "paused")
    throw new Error(`the card is ${status}: a revalidation never resumes it`);
  if (workerOf(db, row.card) !== row.actor)
    throw new Error(`the worker of c-${String(row.card)} is no longer live`);
  if (revalidationsOf(db, row.card) >= MAX_REVALIDATIONS)
    throw new Error(
      `c-${String(row.card)} has used all ${String(MAX_REVALIDATIONS)} revalidations: it needs intervention`,
    );
}

export function revalidate(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"validation.revalidate">,
): Done {
  const row = byId(db, args.validation);
  if (row.parent !== session.lane)
    throw new Error(
      `validation ${String(row.id)} is not yours to revalidate: only ${row.parent ?? "the captain"} can`,
    );
  const child = db.prepare("SELECT * FROM validations WHERE previous = ?").get(row.id);
  if (child !== undefined) {
    const made = validationFrom(child);
    if (made.recoveryKey !== args.key)
      throw new Error(
        `validation ${String(row.id)} already has a revalidation (validation ${String(made.id)})`,
      );
    const value = {
      validation: made.id,
      previous: row.id,
      card: row.card,
      attempts: revalidationsOf(db, row.card),
      repeat: true,
    };
    return { value, notify: [] };
  }
  requireRevalidable(db, row, args);
  const worker = db.prepare("SELECT lane FROM sessions WHERE id = ?").get(row.actor);
  const made = insert(
    db,
    {
      id: row.actor,
      role: "worker",
      lane: String(worker?.["lane"] ?? ""),
      card: row.card,
      live: true,
    },
    row.card,
    { launch: undefined, previous: row.id, key: args.key },
  );
  addEntry(
    db,
    {
      card: row.card,
      author: `mate:${session.lane}`,
      kind: "comment",
      body: `revalidation of validation ${String(row.id)} requested by ${session.lane}: your no-mistakes pipeline is being rerun for you. This is not new work: do not resume or change anything.`,
      fields: { for: "worker", revalidate: made.id, previous: row.id },
    },
    [row.actor],
  );
  const value = {
    validation: made.id,
    previous: row.id,
    card: row.card,
    attempts: revalidationsOf(db, row.card),
    repeat: false,
  };
  return { value, notify: [row.actor] };
}

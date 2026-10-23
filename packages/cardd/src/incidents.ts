import type { DatabaseSync } from "node:sqlite";
import type { OpArgs } from "@fleet/protocol";
import {
  classify,
  eligibleAt,
  remaining,
  sanitize,
  type Mode,
  type Phase,
} from "./incident-kinds.ts";
import {
  generationOf,
  incidentById,
  incidentFrom,
  liveIncident,
  type Incident,
} from "./incident-store.ts";
import { describe, labelOf, nextStep, stamp, tell } from "./incident-text.ts";
import { finishFrom } from "./status.ts";
import { addCard, addEntry, laneCardOf, loadCard, parentOf, type Session } from "./store.ts";
import type { Timings } from "./timing.ts";

interface Recovery {
  readonly incident: number;
  readonly mode: Mode;
  readonly actor: string;
  readonly role: "mate" | "worker";
  readonly lane: string;
  readonly host: string;
  readonly card: number;
  readonly generation: number;
  readonly replaced: boolean;
  readonly repeat: boolean;
}

interface Done {
  readonly value: unknown;
  readonly notify: readonly string[];
}

function intentOf(db: DatabaseSync, card: number, role: "mate" | "worker"): string {
  if (role === "mate") return "working";
  const { card: own, entries } = loadCard(db, card);
  if (own.status === "done" || own.status === "dropped") return "closed";
  if (own.status === "paused") return "paused";
  if (finishFrom(entries).workerDone) return "completed";
  return own.status === "working" || own.status === "in-review" ? "working" : own.status;
}

function cardOfActor(db: DatabaseSync, session: Session, error: string): number {
  if (session.card !== null) return session.card;
  const lane = laneCardOf(db, session.lane);
  if (lane !== undefined) return lane;
  return addCard(db, {
    lane: session.lane,
    title: `${session.lane} runtime failure`,
    name: `${session.lane}-runtime-failure`,
    kind: "captain",
    intent: `${session.lane} hit a runtime failure: ${error}`,
  }).id;
}

export function openIncident(
  db: DatabaseSync,
  actor: { id: string; role: "mate" | "worker"; lane: string; card: number },
  seen: { phase: Phase; error: string; source: string },
  now: number,
  t: Timings,
  silent = false,
): { inc: Incident; notify: string[] } {
  const kind =
    seen.phase === "turn" || seen.phase === "compaction" ? classify(seen.error) : "unknown";
  const eligible = eligibleAt(kind, seen.error, 0, now, t);
  const parent = actor.role === "worker" ? actor.lane : parentOf(db, actor.lane);
  const intent = intentOf(db, actor.card, actor.role);
  const generation = generationOf(db, actor.id);
  const draft = {
    phase: seen.phase,
    classification: kind,
    eligibleAt: eligible,
    retries: 0,
    replacements: 0,
  };
  const state = remaining(draft).length === 0 ? "blocked" : "open";
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO incidents (actor, card, parent, generation, phase, classification, error, source,
         intent, state, eligible_at, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      actor.id,
      actor.card,
      parent,
      generation,
      seen.phase,
      kind,
      seen.error,
      seen.source,
      intent,
      state,
      eligible,
      Date.now(),
      Date.now(),
    );
  const inc = incidentById(db, Number(lastInsertRowid));
  if (inc === undefined) throw new Error("the incident was not saved");
  const notify = silent ? [] : tell(db, inc, actor.role, describe(inc, labelOf(inc, actor.role)));
  return { inc, notify };
}

function failRecovery(
  db: DatabaseSync,
  inc: Incident,
  role: "mate" | "worker",
  error: string,
  t: Timings,
): string[] {
  const kind =
    inc.phase === "turn" || inc.phase === "compaction" ? classify(error) : inc.classification;
  const eligible = eligibleAt(kind, error, inc.retries, t.wall(), t);
  const next = { ...inc, classification: kind, eligibleAt: eligible };
  const state = remaining(next).length === 0 ? "blocked" : "open";
  db.prepare(
    `UPDATE incidents SET state = ?, classification = ?, error = ?, eligible_at = ?, due_told = 0,
       count = count + 1, last_at = ?, recovery_key = NULL, recovery_deadline = NULL
     WHERE id = ?`,
  ).run(state, kind, error, eligible, Date.now(), inc.id);
  const after = incidentById(db, inc.id) ?? inc;
  const body = `recovery of incident ${String(inc.id)} (${inc.recoveryMode ?? "retry"}) did not verify: ${error}. ${state === "blocked" ? "No recovery is left within its bounds: it needs intervention." : nextStep(after)}`;
  return tell(db, after, role, body);
}

export function reportFailure(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"incident.report">,
  t: Timings,
): Done {
  const error = sanitize(args.error);
  const live = liveIncident(db, session.id);
  const now = t.wall();
  if (live?.state === "recovering") {
    return {
      value: { incident: live.id, opened: false },
      notify: failRecovery(db, live, session.role, error, t),
    };
  }
  if (live !== undefined) {
    db.prepare("UPDATE incidents SET count = count + 1, last_at = ? WHERE id = ?").run(
      Date.now(),
      live.id,
    );
    return { value: { incident: live.id, opened: false }, notify: [] };
  }
  const card = cardOfActor(db, session, error);
  const actor = { id: session.id, role: session.role, lane: session.lane, card };
  const made = openIncident(
    db,
    actor,
    {
      phase: args.phase ?? "turn",
      error,
      source:
        args.phase === "compaction"
          ? "the session's compaction error"
          : "the session's own turn error",
    },
    now,
    t,
  );
  return { value: { incident: made.inc.id, opened: true }, notify: made.notify };
}

function verifyCompaction(db: DatabaseSync, live: Incident, role: "mate" | "worker"): Done {
  const reached = db
    .prepare("SELECT 1 FROM deliveries WHERE session = ? AND entry = ? AND state <> 'pending'")
    .get(live.actor, live.recoveryEntry ?? 0);
  if (reached === undefined) return { value: { cleared: false }, notify: [] };
  db.prepare("UPDATE incidents SET state = 'verified', closed_at = ? WHERE id = ?").run(
    Date.now(),
    live.id,
  );
  const body = `incident ${String(live.id)} recovered (${live.recoveryMode ?? ""}): ${live.actor} compacted its conversation successfully. Its conversation, branch, and work are as they were.`;
  return { value: { cleared: true }, notify: tell(db, live, role, body) };
}

export function clearFailure(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"incident.clear">,
): Done {
  const live = liveIncident(db, session.id);
  if (live === undefined || (live.phase === "compaction") !== (args.compacted === true))
    return { value: { cleared: false }, notify: [] };
  if (live.state === "recovering")
    return live.phase === "compaction"
      ? verifyCompaction(db, live, session.role)
      : { value: { cleared: false }, notify: [] };
  db.prepare("UPDATE incidents SET state = 'cleared', closed_at = ? WHERE id = ?").run(
    Date.now(),
    live.id,
  );
  addEntry(
    db,
    {
      card: live.card,
      author: "check",
      kind: "note",
      body: `incident ${String(live.id)} cleared: ${live.actor} answered a later turn in the same process. It was not recovered by anyone.`,
      fields: { condition: "runtime-failure-cleared", incident: live.id },
    },
    [],
  );
  return { value: { cleared: true }, notify: [] };
}

function probeText(
  parent: string,
  role: "mate" | "worker",
  id: number,
  compaction: boolean,
): string {
  if (compaction)
    return `recovery check ${String(id)} from ${parent}: your conversation is being compacted again. This is a health check, not new work. Do not resume, continue, or change any task work.`;
  const action =
    role === "worker"
      ? 'Call report(status="note", text=<one sentence on what you are doing>)'
      : "Call board() once";
  return `recovery check ${String(id)} from ${parent}: this is a health check, not new work. ${action}, then answer in one sentence. Do not resume, continue, or change any task work.`;
}

function recoveryPlan(
  db: DatabaseSync,
  inc: Incident,
  mode: Mode,
  state: { replaced: boolean; repeat: boolean },
): Recovery {
  const row = db.prepare("SELECT role, lane, host FROM sessions WHERE id = ?").get(inc.actor);
  const role = row?.["role"] === "mate" ? "mate" : "worker";
  return {
    incident: inc.id,
    mode,
    actor: inc.actor,
    role,
    lane: String(row?.["lane"] ?? ""),
    host: String(row?.["host"] ?? ""),
    card: inc.card,
    generation: inc.generation,
    ...state,
  };
}

function reject(inc: Incident, parent: string): never {
  if (inc.parent !== parent)
    throw new Error(
      `incident ${String(inc.id)} is not yours to recover: only ${inc.parent ?? "the captain"} can`,
    );
  if (inc.state === "recovering")
    throw new Error(
      `incident ${String(inc.id)} already has a recovery in progress (${inc.recoveryMode ?? ""})`,
    );
  if (inc.state === "blocked")
    throw new Error(
      `incident ${String(inc.id)} is blocked: ${inc.classification} is not repaired by recovering, and its budget is spent or does not apply`,
    );
  throw new Error(`incident ${String(inc.id)} is ${inc.state}: there is nothing to recover`);
}

const repeats = (inc: Incident, args: OpArgs<"incident.recover">): boolean =>
  inc.state === "recovering" && inc.recoveryKey === args.key && inc.recoveryMode === args.mode;

function requireRecoverable(
  db: DatabaseSync,
  inc: Incident,
  args: OpArgs<"incident.recover">,
  t: Timings,
): void {
  const current = generationOf(db, inc.actor);
  if (args.generation !== inc.generation || current !== inc.generation)
    throw new Error(
      `incident ${String(inc.id)} is about process generation ${String(inc.generation)}, but the actor is on ${String(current)} and you named ${String(args.generation)}: read the card again`,
    );
  if (inc.intent !== "working")
    throw new Error(`the card is ${inc.intent}: recovery never resumes it`);
  if (!remaining(inc).includes(args.mode))
    throw new Error(
      `${args.mode} is not available for incident ${String(inc.id)} (${inc.classification}, ${inc.phase}). Available: ${remaining(inc).join(", ") || "none"}`,
    );
  if (inc.eligibleAt !== null && t.wall() < inc.eligibleAt)
    throw new Error(
      `incident ${String(inc.id)} is not eligible for recovery until ${stamp(inc.eligibleAt)}`,
    );
  const running = db
    .prepare(
      `SELECT 1 FROM sessions s LEFT JOIN attempts a ON a.id = s.attempt
       WHERE s.id = ? AND (s.role = 'mate' OR a.state IN ('starting', 'active'))`,
    )
    .get(inc.actor);
  if (running === undefined) throw new Error(`${inc.actor} is no longer a live session`);
}

export function recover(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"incident.recover">,
  t: Timings,
): Done {
  const inc = incidentById(db, args.incident);
  if (inc === undefined) throw new Error(`no incident ${String(args.incident)}`);
  if (inc.parent !== session.lane) reject(inc, session.lane);
  if (repeats(inc, args))
    return {
      value: recoveryPlan(db, inc, args.mode, {
        replaced: generationOf(db, inc.actor) > inc.generation,
        repeat: true,
      }),
      notify: [],
    };
  if (inc.state !== "open") reject(inc, session.lane);
  requireRecoverable(db, inc, args, t);
  const plan = recoveryPlan(db, inc, args.mode, { replaced: false, repeat: false });
  const live = args.mode === "retry";
  const compaction = inc.phase === "compaction";
  const body = probeText(session.lane, plan.role, inc.id, compaction);
  const fields = { for: plan.role, recovery: inc.id, ...(compaction ? { compaction } : {}) };
  const draft = { card: inc.card, author: `mate:${session.lane}`, kind: "comment", body, fields };
  const entry = addEntry(db, draft, live ? [inc.actor] : []);
  db.prepare(
    `UPDATE incidents SET state = 'recovering', recovery_key = ?, recovery_mode = ?, recovery_entry = ?,
       recovery_deadline = ?, control_at = NULL, due_told = 1,
       retries = retries + ?, replacements = replacements + ?
     WHERE id = ? AND state = 'open'`,
  ).run(args.key, args.mode, entry, Date.now() + t.verify, live ? 1 : 0, live ? 0 : 1, inc.id);
  return { value: plan, notify: live ? [inc.actor] : [] };
}

function reconnected(db: DatabaseSync, session: string): void {
  const live = liveIncident(db, session);
  if (live === undefined || (live.phase !== "lost" && live.phase !== "startup")) return;
  db.prepare("UPDATE incidents SET state = 'cleared', closed_at = ? WHERE id = ?").run(
    Date.now(),
    live.id,
  );
}

export function adoptProcess(db: DatabaseSync, session: string, process: string | undefined): void {
  db.prepare("UPDATE sessions SET stopping = 0 WHERE id = ?").run(session);
  if (process === undefined) return;
  const known = db.prepare("SELECT process FROM sessions WHERE id = ?").get(session)?.["process"];
  if (known === process) {
    reconnected(db, session);
    return;
  }
  db.prepare("UPDATE sessions SET process = ?, generation = generation + 1 WHERE id = ?").run(
    process,
    session,
  );
  const live = liveIncident(db, session);
  if (live === undefined) return;
  if (live.state === "recovering") {
    if (live.recoveryMode === "replace" && live.recoveryEntry !== null)
      db.prepare(
        "INSERT OR IGNORE INTO deliveries (session, entry, state, updated_at) VALUES (?, ?, 'pending', ?)",
      ).run(session, live.recoveryEntry, Date.now());
    return;
  }
  db.prepare("UPDATE incidents SET state = 'superseded', closed_at = ? WHERE id = ?").run(
    Date.now(),
    live.id,
  );
}

const CONTROL_OPS: ReadonlySet<string> = new Set(["report", "comment", "board"]);

export function noteControl(db: DatabaseSync, session: string, op: string): void {
  if (!CONTROL_OPS.has(op)) return;
  db.prepare(
    `UPDATE incidents SET control_at = ?
     WHERE actor = ? AND state = 'recovering' AND control_at IS NULL
       AND EXISTS (SELECT 1 FROM deliveries d WHERE d.session = incidents.actor
         AND d.entry = incidents.recovery_entry AND d.state <> 'pending')`,
  ).run(Date.now(), session);
}

function roleOf(db: DatabaseSync, actor: string): "mate" | "worker" {
  return db.prepare("SELECT role FROM sessions WHERE id = ?").get(actor)?.["role"] === "mate"
    ? "mate"
    : "worker";
}

function answeredAndActed(db: DatabaseSync, inc: Incident, acted: boolean): boolean {
  if (inc.phase === "compaction" || !acted) return false;
  const taken = db
    .prepare("SELECT 1 FROM deliveries WHERE session = ? AND entry = ? AND intake = 'taken'")
    .get(inc.actor, inc.recoveryEntry ?? 0);
  return taken !== undefined;
}

export function reconcileIncidents(db: DatabaseSync, now: number, t: Timings): string[] {
  const notify: string[] = [];
  const recovering = db.prepare("SELECT * FROM incidents WHERE state = 'recovering'").all();
  for (const row of recovering) {
    const inc = incidentFrom(row);
    const role = roleOf(db, inc.actor);
    if (answeredAndActed(db, inc, row["control_at"] !== null)) {
      db.prepare("UPDATE incidents SET state = 'verified', closed_at = ? WHERE id = ?").run(
        now,
        inc.id,
      );
      const body = `incident ${String(inc.id)} recovered (${inc.recoveryMode ?? ""}): ${inc.actor} answered the recovery check and acted. Its conversation, branch, and work are as they were.`;
      notify.push(...tell(db, inc, role, body));
    } else if (Number(row["recovery_deadline"]) < now) {
      notify.push(
        ...failRecovery(
          db,
          inc,
          role,
          "no real response and action within the verification window",
          t,
        ),
      );
    }
  }
  const due = db
    .prepare(
      "SELECT * FROM incidents WHERE state = 'open' AND due_told = 0 AND eligible_at IS NOT NULL AND eligible_at <= ?",
    )
    .all(t.wall());
  for (const row of due) {
    const inc = incidentFrom(row);
    db.prepare("UPDATE incidents SET due_told = 1 WHERE id = ?").run(inc.id);
    const modes = remaining(inc);
    if (modes.length === 0 || inc.intent !== "working") continue;
    const body = `incident ${String(inc.id)} is eligible for recovery now: recover(incident=${String(inc.id)}, generation=${String(inc.generation)}, mode=${modes.join(" or ")}).`;
    notify.push(...tell(db, inc, roleOf(db, inc.actor), body));
  }
  return notify;
}

export function watchdogIncident(
  db: DatabaseSync,
  card: number,
  phase: "startup" | "lost",
  now: number,
  t: Timings,
): string | undefined {
  const row = db
    .prepare(
      `SELECT s.id AS id, s.lane AS lane, s.role AS role FROM sessions s JOIN attempts a ON a.id = s.attempt
       WHERE a.card = ? AND a.state IN ('starting', 'active')`,
    )
    .get(card);
  if (row === undefined) return undefined;
  const actor = String(row["id"]);
  const live = liveIncident(db, actor);
  if (live !== undefined) return `See incident ${String(live.id)}.`;
  const intent = intentOf(db, card, "worker");
  if (intent !== "working") return undefined;
  const detail =
    phase === "startup" ? "no connection after launch" : "connection lost with no final event";
  const made = openIncident(
    db,
    { id: actor, role: "worker", lane: String(row["lane"]), card },
    { phase, error: detail, source: "the timed check" },
    now,
    t,
    true,
  );
  const ids = `Incident ${String(made.inc.id)}, process generation ${String(made.inc.generation)}.`;
  return `${ids} ${nextStep(made.inc)}`;
}

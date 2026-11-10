import type { DatabaseSync } from "node:sqlite";
import type { Status } from "@fleet/protocol";
import type { Kind, Mode, Phase } from "./incident-kinds.ts";
import { isFinished, pausedNow } from "./status.ts";
import { loadCard } from "./store.ts";

const INCIDENT_STATES = [
  "open",
  "recovering",
  "blocked",
  "verified",
  "cleared",
  "superseded",
] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

const INCIDENT_INTENTS = [
  "working",
  "paused",
  "completed",
  "closed",
  "queued",
  "with-mate",
  "needs-you",
  "waiting",
  "merging",
] as const;
export type IncidentIntent = (typeof INCIDENT_INTENTS)[number];

const LIVE_STATES = ["open", "recovering", "blocked"] as const;

export function liveStateSql(): string {
  return LIVE_STATES.map((state) => `'${state}'`).join(", ");
}

export function incidentState(value: unknown): IncidentState {
  const found = INCIDENT_STATES.find((state) => state === value);
  if (found === undefined) throw new Error(`incident state ${JSON.stringify(value)} is not known`);
  return found;
}

export function incidentIntent(value: unknown): IncidentIntent {
  const found = INCIDENT_INTENTS.find((intent) => intent === value);
  if (found === undefined) throw new Error(`incident intent ${JSON.stringify(value)} is not known`);
  return found;
}

export function recoveryOffered(intent: IncidentIntent): boolean {
  return intent === "working" || intent === "merging";
}

function closedOrPaused(status: Status): IncidentIntent | undefined {
  if (status === "done" || status === "dropped") return "closed";
  return status === "paused" ? "paused" : undefined;
}

function workingOrStored(status: Status): IncidentIntent | undefined {
  if (status === "working" || status === "in-review" || status === "merging") return "working";
  if (
    status === "queued" ||
    status === "with-mate" ||
    status === "needs-you" ||
    status === "waiting"
  )
    return status;
  return undefined;
}

function storedIntent(status: Status): IncidentIntent {
  return closedOrPaused(status) ?? workingOrStored(status) ?? incidentIntent(status);
}

export function intentOf(db: DatabaseSync, card: number, role: "mate" | "worker"): IncidentIntent {
  if (role === "mate") return "working";
  const { card: own, entries, standing } = loadCard(db, card);
  if (own.status === "done" || own.status === "dropped") return "closed";
  if (pausedNow(standing, Date.now())) return "paused";
  if (isFinished(entries)) return "completed";
  return storedIntent(own.status);
}

interface OpenedRow {
  readonly actor: string;
  readonly card: number;
  readonly parent: string | null;
  readonly generation: number;
  readonly phase: Phase;
  readonly classification: Kind;
  readonly error: string;
  readonly source: string;
  readonly intent: IncidentIntent;
  readonly eligibleAt: number | null;
  readonly recoverable: boolean;
  readonly at: number;
}

export function insertOpened(db: DatabaseSync, row: OpenedRow): number {
  const state = nextIncident(undefined, { type: "opened", recoverable: row.recoverable });
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO incidents (actor, card, parent, generation, phase, classification, error, source,
         intent, state, eligible_at, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.actor,
      row.card,
      row.parent,
      row.generation,
      row.phase,
      row.classification,
      row.error,
      row.source,
      row.intent,
      state,
      row.eligibleAt,
      row.at,
      row.at,
    );
  return Number(lastInsertRowid);
}

export function closeCardIncidents(db: DatabaseSync, card: number, at: number): void {
  const rows = db
    .prepare(
      `SELECT id, state, phase FROM incidents WHERE card = ? AND state IN (${liveStateSql()})`,
    )
    .all(card);
  for (const row of rows) {
    applyIncident(
      db,
      { id: Number(row["id"]), state: incidentState(row["state"]), phase: phaseOf(row["phase"]) },
      { type: "card-closed" },
      at,
    );
  }
}

const PHASES = ["turn", "compaction", "startup", "lost"] as const;

function phaseOf(value: unknown): Phase {
  const found = PHASES.find((phase) => phase === value);
  if (found === undefined) throw new Error(`incident phase ${JSON.stringify(value)} is not known`);
  return found;
}

interface IncidentView {
  readonly id: number;
  readonly state: IncidentState;
  readonly phase: Phase;
}

type IncidentEvent =
  | { readonly type: "opened"; readonly recoverable: boolean }
  | {
      readonly type: "recovery-failed";
      readonly recoverable: boolean;
      readonly classification: Kind;
      readonly error: string;
      readonly eligibleAt: number | null;
    }
  | {
      readonly type: "recovery-started";
      readonly key: string;
      readonly mode: Mode;
      readonly entry: number;
      readonly deadline: number;
      readonly retry: boolean;
    }
  | { readonly type: "verified" }
  | { readonly type: "cleared" }
  | { readonly type: "reconnected" }
  | { readonly type: "process-changed" }
  | { readonly type: "card-closed" }
  | { readonly type: "repeated" }
  | { readonly type: "due-told" }
  | { readonly type: "controlled"; readonly actor: string };

type From = IncidentState | "none";

interface Edge {
  readonly from: readonly From[];
  readonly to: IncidentState | "keep" | ((recoverable: boolean) => IncidentState);
}

const EDGES: Record<IncidentEvent["type"], Edge> = {
  opened: { from: ["none"], to: (recoverable) => (recoverable ? "open" : "blocked") },
  "recovery-failed": {
    from: ["recovering"],
    to: (recoverable) => (recoverable ? "open" : "blocked"),
  },
  "recovery-started": { from: ["open"], to: "recovering" },
  verified: { from: ["recovering"], to: "verified" },
  cleared: { from: ["open", "blocked"], to: "cleared" },
  reconnected: { from: ["open", "blocked", "recovering"], to: "cleared" },
  "process-changed": { from: ["open", "blocked"], to: "superseded" },
  "card-closed": { from: ["open", "recovering", "blocked"], to: "superseded" },
  repeated: { from: ["open", "blocked"], to: "keep" },
  "due-told": { from: ["open"], to: "keep" },
  controlled: { from: ["recovering"], to: "keep" },
};

const TERMINAL = ["verified", "cleared", "reconnected", "process-changed", "card-closed"] as const;
type Terminal = (typeof TERMINAL)[number];

function isTerminal(type: IncidentEvent["type"]): type is Terminal {
  return TERMINAL.some((each) => each === type);
}

function refuseReconnect(
  incident: { readonly phase: Phase } | undefined,
  event: IncidentEvent,
): void {
  if (event.type !== "reconnected") return;
  if (incident?.phase === "lost" || incident?.phase === "startup") return;
  throw new Error("a reconnect clears only a lost or startup incident");
}

function keptState(
  incident: { readonly state: IncidentState } | undefined,
  event: IncidentEvent,
): IncidentState {
  if (incident === undefined) throw new Error(`incident ${event.type} needs an incident`);
  return incident.state;
}

function movedState(event: IncidentEvent, to: Edge["to"]): IncidentState {
  if (to === "keep") throw new Error(`incident ${event.type} keeps its state`);
  if (typeof to !== "function") return to;
  const recoverable =
    event.type === "opened" || event.type === "recovery-failed" ? event.recoverable : false;
  return to(recoverable);
}

function nextIncident(
  incident: { readonly state: IncidentState; readonly phase: Phase } | undefined,
  event: IncidentEvent,
): IncidentState {
  refuseReconnect(incident, event);
  const edge = EDGES[event.type];
  const from = incident === undefined ? "none" : incident.state;
  if (!edge.from.includes(from)) throw new Error(`incident ${event.type} does not follow ${from}`);
  return edge.to === "keep" ? keptState(incident, event) : movedState(event, edge.to);
}

function required(incident: IncidentView | undefined): IncidentView {
  if (incident === undefined) throw new Error("the incident is missing");
  return incident;
}

function recoveringView(db: DatabaseSync, actor: string): IncidentView | undefined {
  const row = db
    .prepare(
      "SELECT id, state, phase FROM incidents WHERE actor = ? AND state = 'recovering' AND control_at IS NULL",
    )
    .get(actor);
  if (row === undefined) return undefined;
  return {
    id: Number(row["id"]),
    state: incidentState(row["state"]),
    phase: phaseOf(row["phase"]),
  };
}

function subjectOf(
  db: DatabaseSync,
  incident: IncidentView | undefined,
  event: IncidentEvent,
): IncidentView | undefined {
  return event.type === "controlled" ? recoveringView(db, event.actor) : incident;
}

function writeFailed(
  db: DatabaseSync,
  id: number,
  state: IncidentState,
  event: Extract<IncidentEvent, { type: "recovery-failed" }>,
  at: number,
): void {
  db.prepare(
    `UPDATE incidents SET state = ?, classification = ?, error = ?, eligible_at = ?, due_told = 0,
       count = count + 1, last_at = ?, recovery_key = NULL, recovery_deadline = NULL
     WHERE id = ?`,
  ).run(state, event.classification, event.error, event.eligibleAt, at, id);
}

function writeStarted(
  db: DatabaseSync,
  id: number,
  state: IncidentState,
  event: Extract<IncidentEvent, { type: "recovery-started" }>,
): void {
  const retry = event.retry ? 1 : 0;
  db.prepare(
    `UPDATE incidents SET state = ?, recovery_key = ?, recovery_mode = ?, recovery_entry = ?,
       recovery_deadline = ?, control_at = NULL, due_told = 1,
       retries = retries + ?, replacements = replacements + ?
     WHERE id = ? AND state = 'open'`,
  ).run(state, event.key, event.mode, event.entry, event.deadline, retry, event.retry ? 0 : 1, id);
}

function writeClosed(
  db: DatabaseSync,
  incident: IncidentView,
  state: IncidentState,
  at: number,
): void {
  db.prepare("UPDATE incidents SET state = ?, closed_at = ? WHERE id = ? AND state = ?").run(
    state,
    at,
    incident.id,
    incident.state,
  );
}

function writeRepeated(db: DatabaseSync, incident: IncidentView, at: number): void {
  db.prepare("UPDATE incidents SET count = count + 1, last_at = ? WHERE id = ? AND state = ?").run(
    at,
    incident.id,
    incident.state,
  );
}

function writeDue(db: DatabaseSync, id: number): void {
  db.prepare("UPDATE incidents SET due_told = 1 WHERE id = ? AND state = 'open'").run(id);
}

function writeControlled(db: DatabaseSync, actor: string, at: number): void {
  db.prepare(
    `UPDATE incidents SET control_at = ?
     WHERE actor = ? AND state = 'recovering' AND control_at IS NULL
       AND EXISTS (SELECT 1 FROM deliveries d WHERE d.session = incidents.actor
         AND d.entry = incidents.recovery_entry AND d.state <> 'pending')`,
  ).run(at, actor);
}

function writeLive(
  db: DatabaseSync,
  incident: IncidentView | undefined,
  state: IncidentState,
  event: IncidentEvent,
  at: number,
): void {
  if (event.type === "recovery-failed") {
    writeFailed(db, required(incident).id, state, event, at);
    return;
  }
  if (event.type === "recovery-started") {
    writeStarted(db, required(incident).id, state, event);
    return;
  }
  if (event.type === "repeated") {
    writeRepeated(db, required(incident), at);
    return;
  }
  if (event.type === "due-told") {
    writeDue(db, required(incident).id);
    return;
  }
  if (event.type === "controlled") {
    writeControlled(db, event.actor, at);
    return;
  }
  if (event.type === "opened") throw new Error("an opened incident is inserted, not updated");
  throw new Error(`incident ${event.type} has no writer`);
}

export function applyIncident(
  db: DatabaseSync,
  incident: IncidentView | undefined,
  event: IncidentEvent,
  at: number,
): void {
  const subject = subjectOf(db, incident, event);
  if (subject === undefined && event.type === "controlled") return;
  const state = nextIncident(subject, event);
  if (isTerminal(event.type)) {
    writeClosed(db, required(subject), state, at);
    return;
  }
  writeLive(db, subject, state, event, at);
}

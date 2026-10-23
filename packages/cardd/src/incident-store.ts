import type { DatabaseSync } from "node:sqlite";
import type { Kind, Mode, Phase } from "./incident-kinds.ts";

export interface Incident {
  readonly id: number;
  readonly actor: string;
  readonly card: number;
  readonly parent: string | null;
  readonly generation: number;
  readonly phase: Phase;
  readonly classification: Kind;
  readonly error: string;
  readonly intent: string;
  readonly state: string;
  readonly retries: number;
  readonly replacements: number;
  readonly eligibleAt: number | null;
  readonly recoveryKey: string | null;
  readonly recoveryMode: Mode | null;
  readonly recoveryEntry: number | null;
}

const KIND_NAMES: readonly Kind[] = [
  "stale-module",
  "router-cooldown",
  "vendor-quota",
  "auth",
  "transient",
];
const kindOf = (value: unknown): Kind => KIND_NAMES.find((kind) => kind === value) ?? "unknown";

function numberOf(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function incidentFrom(row: Record<string, unknown>): Incident {
  const phase = row["phase"];
  const mode = row["recovery_mode"];
  return {
    id: Number(row["id"]),
    actor: String(row["actor"]),
    card: Number(row["card"]),
    parent: stringOf(row["parent"]),
    generation: Number(row["generation"]),
    phase: phase === "startup" || phase === "lost" ? phase : "turn",
    classification: kindOf(row["classification"]),
    error: String(row["error"]),
    intent: String(row["intent"]),
    state: String(row["state"]),
    retries: Number(row["retries"]),
    replacements: Number(row["replacements"]),
    eligibleAt: numberOf(row["eligible_at"]),
    recoveryKey: stringOf(row["recovery_key"]),
    recoveryMode: mode === "retry" || mode === "replace" ? mode : null,
    recoveryEntry: numberOf(row["recovery_entry"]),
  };
}

export function incidentById(db: DatabaseSync, id: number): Incident | undefined {
  const row = db.prepare("SELECT * FROM incidents WHERE id = ?").get(id);
  return row === undefined ? undefined : incidentFrom(row);
}

export function liveIncident(db: DatabaseSync, actor: string): Incident | undefined {
  const row = db
    .prepare(
      "SELECT * FROM incidents WHERE actor = ? AND state IN ('open', 'recovering', 'blocked')",
    )
    .get(actor);
  return row === undefined ? undefined : incidentFrom(row);
}

export function generationOf(db: DatabaseSync, actor: string): number {
  return Number(
    db.prepare("SELECT generation FROM sessions WHERE id = ?").get(actor)?.["generation"] ?? 0,
  );
}

export const LIVE_INCIDENT = `EXISTS (SELECT 1 FROM incidents i WHERE i.actor = SESSION AND i.state IN ('open', 'recovering', 'blocked'))`;

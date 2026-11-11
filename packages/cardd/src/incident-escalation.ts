import type { DatabaseSync } from "node:sqlite";
import { exhaustion, remaining } from "./incident-kinds.ts";
import { liveStateSql, recoveryOffered } from "./incident-lifecycle.ts";
import { incidentFrom, type Incident } from "./incident-store.ts";
import { FAILURE_OF, stamp } from "./incident-text.ts";
import { addEntry, transaction } from "./store.ts";

export const UNRECOVERABLE = "runtime-failure-unrecoverable";
const REFUSED = "restart-refused";

export class AvoidRefused extends Error {
  readonly card: number;
  readonly model: string;
  readonly provider: string;
  readonly incident: Incident | undefined;

  constructor(card: number, model: string, provider: string, incident?: Incident) {
    super(
      `c-${String(card)} is pinned to ${model} and a restart keeps that model, so it cannot avoid ${provider}: restart without avoid, or pin a model from another provider`,
    );
    this.card = card;
    this.model = model;
    this.provider = provider;
    this.incident = incident;
  }
}

const ENTRY_OF = `SELECT body FROM entries WHERE author = 'check' AND json_extract(fields, '$.condition') = ?
  AND card = ? AND json_extract(fields, '$.incident') = ? ORDER BY id LIMIT 1`;

const bodyOf = (db: DatabaseSync, condition: string, inc: Incident): string | undefined => {
  const body = db.prepare(ENTRY_OF).get(condition, inc.card, inc.id)?.["body"];
  return typeof body === "string" ? body : undefined;
};

export const told = (db: DatabaseSync, inc: Incident): boolean =>
  bodyOf(db, UNRECOVERABLE, inc) !== undefined;

function noteRefusal(db: DatabaseSync, refused: AvoidRefused): void {
  const { incident } = refused;
  if (incident === undefined || bodyOf(db, REFUSED, incident) !== undefined) return;
  const body = `a restart avoiding ${refused.provider} was refused: c-${String(refused.card)} was dispatched on ${refused.model}, and a restart keeps that model`;
  const fields = { condition: REFUSED, incident: incident.id };
  addEntry(db, { card: refused.card, author: "check", kind: "note", body, fields }, []);
}

export async function keepingRefusals<T>(db: DatabaseSync, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AvoidRefused)
      transaction(db, () => {
        noteRefusal(db, error);
      });
    throw error;
  }
}

const LIVE_OF_WORKERS_IN_SECOND_LANES = `SELECT i.* FROM incidents i
  JOIN sessions s ON s.id = i.actor AND s.role = 'worker'
  JOIN lanes l ON l.name = i.parent
  WHERE i.state IN (${liveStateSql()}) AND l.parent IS NOT NULL`;

function whyNoRecovery(db: DatabaseSync, inc: Incident): string | undefined {
  if (inc.state === "blocked") return exhaustion(inc);
  if (inc.state === "recovering" && !told(db, inc)) return undefined;
  return bodyOf(db, REFUSED, inc);
}

export interface Unrecoverable {
  readonly incident: Incident;
  readonly lane: string;
  readonly reason: string;
}

export function unrecoverable(db: DatabaseSync): Unrecoverable[] {
  return db
    .prepare(LIVE_OF_WORKERS_IN_SECOND_LANES)
    .all()
    .map(incidentFrom)
    .flatMap((incident) => {
      const { parent: lane } = incident;
      if (lane === null || !recoveryOffered(incident.intent)) return [];
      const reason = whyNoRecovery(db, incident);
      return reason === undefined ? [] : [{ incident, lane, reason }];
    });
}

export function escalationText(
  { incident: inc, lane, reason }: Unrecoverable,
  wall: number,
): string {
  const cause = inc.phase === "turn" || inc.phase === "compaction" ? `: ${inc.error}` : "";
  const pending =
    inc.eligibleAt !== null && inc.eligibleAt > wall && remaining(inc).includes("retry")
      ? ` A retry is still pending, eligible at ${stamp(inc.eligibleAt)}.`
      : "";
  return `runtime failure with no recovery left: c-${String(inc.card)} in lane ${lane}, incident ${String(inc.id)}, ${FAILURE_OF[inc.phase]}${cause} (classified ${inc.classification}). Why: ${reason}.${pending} ${lane} was told and cannot recover it, so it needs you.`;
}

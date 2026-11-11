import type { DatabaseSync } from "node:sqlite";
import type { OpArgs } from "@fleet/protocol";
import { connected, liveAttemptModel, repinAttempt } from "./attempts.ts";
import { requireOpen } from "./change.ts";
import { AvoidRefused } from "./incident-escalation.ts";
import { generationOf, incidentById, type Incident } from "./incident-store.ts";
import { intentOf, type IncidentIntent } from "./incident-lifecycle.ts";
import { recover, requireCurrent } from "./incidents.ts";
import { addEntry, getCard, laneCardOf, type Session } from "./store.ts";
import type { Timings } from "./timing.ts";

const RESTARTS_PER_HOUR = 3;
const RESTING_INTENTS: ReadonlySet<IncidentIntent> = new Set([
  "completed",
  "paused",
  "waiting",
  "needs-you",
]);
const HOUR_MS = 3_600_000;

interface Target {
  readonly actor: string;
  readonly host: string;
  readonly role: "mate" | "worker";
}

function targetOf(db: DatabaseSync, card: number, lane: string, mate: boolean): Target {
  const row = mate
    ? db.prepare("SELECT id, host FROM sessions WHERE role = 'mate' AND lane = ?").get(lane)
    : db
        .prepare(
          `SELECT s.id AS id, s.host AS host FROM sessions s JOIN attempts a ON a.id = s.attempt
           WHERE a.card = ? AND a.state IN ('starting', 'active')`,
        )
        .get(card);
  if (row === undefined) throw new Error(`c-${String(card)} has no session to restart`);
  return { actor: String(row["id"]), host: String(row["host"]), role: mate ? "mate" : "worker" };
}

function restartsInLastHour(db: DatabaseSync, card: number): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM entries
       WHERE card = ? AND kind = 'note' AND json_extract(fields, '$.restartKey') IS NOT NULL AND created_at > ?`,
    )
    .get(card, Date.now() - HOUR_MS);
  return Number(row?.["n"]);
}

function alreadyRequested(db: DatabaseSync, card: number, key: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM entries WHERE card = ? AND kind = 'note' AND json_extract(fields, '$.restartKey') = ?",
    )
    .get(card, key);
  return row !== undefined;
}

function refuseAvoidedModel(
  db: DatabaseSync,
  card: number,
  avoid: readonly string[],
  pinned: string | undefined,
  incident?: Incident,
): void {
  const model = pinned ?? liveAttemptModel(db, card);
  if (model === undefined) return;
  const provider = model.slice(0, model.indexOf("/"));
  if (avoid.includes(provider))
    throw new AvoidRefused(card, model, provider, pinned === undefined ? incident : undefined);
}

function requireDirectParent(
  session: Session,
  card: { id: number; lane: string },
  mate: boolean,
): void {
  if (mate ? session.lane !== "main" : session.lane !== card.lane)
    throw new Error(`only the direct parent can restart c-${String(card.id)}`);
}

function refuseLaunchOption(args: OpArgs<"card.restart">, mate: boolean): void {
  const option = (["avoid", "model"] as const).find((name) => args[name] !== undefined);
  if (option !== undefined && (args.mode === "retry" || mate))
    throw new Error(
      `${option} applies only when a worker's process is replaced: retry and a second mate's restart start no new worker process`,
    );
}

function repin(db: DatabaseSync, lane: string, card: number, model: string): void {
  const { previous } = repinAttempt(db, card, model);
  if (previous === model) return;
  const was = previous ?? "the lane's normal model selection";
  const body = `Model pin changed from ${was} to ${model}. Every restart keeps it.`;
  addEntry(db, { card, author: `mate:${lane}`, kind: "note", body, fields: { model } }, []);
}

interface Planned {
  readonly value: { readonly repeat: boolean };
  readonly notify: readonly string[];
}

function refusedRestart(intent: IncidentIntent, connectedWorker: boolean): Error {
  const why = connectedWorker
    ? ", and its worker is connected, so there is nothing to reconnect: restart replaces only a worker that is disconnected"
    : "";
  return new Error(`the card is ${intent}: restart never resumes paused or finished work${why}`);
}

interface Restartable {
  readonly target: Target;
  readonly repeat: boolean;
  readonly resting: boolean;
}

function restartable(
  db: DatabaseSync,
  card: { id: number; lane: string },
  mate: boolean,
  key: string,
): Restartable {
  const intent = intentOf(db, card.id, mate ? "mate" : "worker");
  const resting = RESTING_INTENTS.has(intent);
  if (!resting && intent !== "working" && intent !== "with-mate")
    throw refusedRestart(intent, false);
  const target = targetOf(db, card.id, card.lane, mate);
  const repeat = alreadyRequested(db, card.id, key);
  if (resting && !repeat && connected(db, target.actor)) throw refusedRestart(intent, true);
  return { target, repeat, resting };
}

function ordinaryRestart(
  db: DatabaseSync,
  session: Session,
  card: { id: number; lane: string },
  mate: boolean,
  key: string,
): Planned {
  if (!mate) requireOpen(db, getCard(db, card.id));
  const { target, repeat, resting } = restartable(db, card, mate, key);
  if (!repeat && restartsInLastHour(db, card.id) >= RESTARTS_PER_HOUR)
    throw new Error(
      `c-${String(card.id)} was restarted ${String(RESTARTS_PER_HOUR)} times in the last hour`,
    );
  const generation = generationOf(db, target.actor);
  if (!repeat) {
    const body = resting
      ? "Reconnect requested: the worker's process was disconnected. The card keeps its state and nothing is resumed."
      : "Restart requested on the same conversation, branch, and work.";
    const fields = { restartKey: key, generation };
    addEntry(db, { card: card.id, author: `mate:${session.lane}`, kind: "note", body, fields }, []);
  }
  const value = {
    ...target,
    card: card.id,
    incident: null,
    mode: "replace",
    lane: card.lane,
    generation,
    replaced: false,
    repeat,
    reconnect: resting,
  };
  return { value, notify: [] };
}

function restartIncident(
  db: DatabaseSync,
  session: Session,
  card: { id: number },
  incident: number,
  args: OpArgs<"card.restart">,
  timing: Timings,
): Planned {
  const { generation, avoid } = args;
  if (generation === undefined)
    throw new Error("an incident restart needs the incident's generation");
  const found = incidentById(db, incident);
  if (found?.card !== card.id)
    throw new Error(`incident ${String(incident)} is not an incident of c-${String(card.id)}`);
  if (avoid !== undefined && found.state === "open") {
    requireCurrent(db, found, generation);
    refuseAvoidedModel(db, card.id, avoid, args.model, found);
  }
  return recover(db, session, { incident, generation, mode: args.mode, key: args.key }, timing);
}

function planRestart(
  db: DatabaseSync,
  session: Session,
  card: { id: number; lane: string },
  mate: boolean,
  args: OpArgs<"card.restart">,
  timing: Timings,
): Planned {
  if (args.incident !== undefined)
    return restartIncident(db, session, card, args.incident, args, timing);
  if (args.avoid !== undefined) refuseAvoidedModel(db, card.id, args.avoid, args.model);
  if (args.mode === "retry")
    throw new Error("retry needs an incident: name the incident and its generation");
  return ordinaryRestart(db, session, card, mate, args.key);
}

export function restartCard(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"card.restart">,
  timing: Timings,
): Planned {
  const card = getCard(db, args.card);
  const mate = laneCardOf(db, card.lane) === card.id;
  requireDirectParent(session, card, mate);
  refuseLaunchOption(args, mate);
  const planned = planRestart(db, session, card, mate, args, timing);
  if (args.model !== undefined && !planned.value.repeat)
    repin(db, session.lane, card.id, args.model);
  return planned;
}

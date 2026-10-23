import type { DatabaseSync } from "node:sqlite";
import type { OpArgs } from "@fleet/protocol";
import { requireOpen } from "./change.ts";
import { generationOf, incidentById } from "./incident-store.ts";
import { intentOf, recover } from "./incidents.ts";
import { addEntry, getCard, laneCardOf, type Session } from "./store.ts";
import type { Timings } from "./timing.ts";

const RESTARTS_PER_HOUR = 3;
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

function ordinaryRestart(
  db: DatabaseSync,
  session: Session,
  card: { id: number; lane: string },
  mate: boolean,
  key: string,
): { value: unknown; notify: readonly string[] } {
  if (mate ? session.lane !== "main" : session.lane !== card.lane)
    throw new Error(`only the direct parent can restart c-${String(card.id)}`);
  if (!mate) requireOpen(db, getCard(db, card.id));
  const intent = intentOf(db, card.id, mate ? "mate" : "worker");
  if (intent !== "working" && intent !== "with-mate")
    throw new Error(`the card is ${intent}: restart never resumes paused or finished work`);
  const target = targetOf(db, card.id, card.lane, mate);
  const repeat = alreadyRequested(db, card.id, key);
  if (!repeat && restartsInLastHour(db, card.id) >= RESTARTS_PER_HOUR)
    throw new Error(
      `c-${String(card.id)} was restarted ${String(RESTARTS_PER_HOUR)} times in the last hour`,
    );
  const generation = generationOf(db, target.actor);
  if (!repeat) {
    const body = "Restart requested on the same conversation, branch, and work.";
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
  };
  return { value, notify: [] };
}

export function restartCard(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"card.restart">,
  timing: Timings,
): { value: unknown; notify: readonly string[] } {
  const card = getCard(db, args.card);
  const mate = laneCardOf(db, card.lane) === card.id;
  const { incident, generation } = args;
  if (args.avoid !== undefined && (args.mode === "retry" || mate))
    throw new Error(
      "avoid applies only when a worker's process is replaced: retry and a second mate's restart start no new worker process",
    );
  if (incident === undefined) {
    if (args.mode === "retry")
      throw new Error("retry needs an incident: name the incident and its generation");
    return ordinaryRestart(db, session, card, mate, args.key);
  }
  if (generation === undefined)
    throw new Error("an incident restart needs the incident's generation");
  if (incidentById(db, incident)?.card !== card.id)
    throw new Error(`incident ${String(incident)} is not an incident of c-${String(card.id)}`);
  return recover(db, session, { incident, generation, mode: args.mode, key: args.key }, timing);
}

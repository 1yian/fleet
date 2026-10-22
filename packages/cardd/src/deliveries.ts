import type { DatabaseSync } from "node:sqlite";
import { check, EntrySchema, PushedEntrySchema, type Entry } from "@fleet/protocol";
import { quietSql } from "./attempts.ts";
import { addEntry, ENTRY_JSON, getCard, json, parentOf } from "./store.ts";
import type { Timings } from "./timing.ts";

export interface Push {
  readonly entry: Entry;
  readonly name: string;
  readonly mode: "steer" | "followUp";
  readonly again: boolean;
}

export function confirm(db: DatabaseSync, session: string, inFile: readonly number[]): number {
  const mark = db.prepare(
    "UPDATE deliveries SET state = 'confirmed', updated_at = ? WHERE session = ? AND entry = ?",
  );
  for (const entry of inFile) mark.run(Date.now(), session, entry);
  const row = db
    .prepare(
      `SELECT coalesce(
         (SELECT min(entry) - 1 FROM deliveries WHERE session = ?1 AND state <> 'confirmed'),
         (SELECT max(entry) FROM deliveries WHERE session = ?1),
         0) AS low`,
    )
    .get(session);
  const low = Number(row?.["low"]);
  db.prepare("UPDATE sessions SET low_water = ? WHERE id = ?").run(low, session);
  return low;
}

export function toPush(db: DatabaseSync, session: string, atConnect: boolean): Push[] {
  const states = atConnect ? "('pending', 'pushed', 'acknowledged')" : "('pending')";
  const rows = json(
    db,
    `SELECT json_object('entry', json(${ENTRY_JSON}), 'name', c.name,
       'again', json(iif(d.intake IN ('resent', 'escalated'), 'true', 'false'))) AS j
     FROM deliveries d JOIN entries e ON e.id = d.entry JOIN cards c ON c.id = e.card
     WHERE d.session = ? AND d.state IN ${states} ORDER BY e.id`,
    session,
  );
  const pushes = rows.map((row) => {
    const { entry, name, again = false } = check(PushedEntrySchema, row);
    return {
      entry,
      name,
      again,
      mode: entry.fields["now"] === true ? "steer" : "followUp",
    } as const;
  });
  const mark = db.prepare(
    "UPDATE deliveries SET state = 'pushed', updated_at = ? WHERE session = ? AND entry = ? AND state = 'pending'",
  );
  for (const { entry } of pushes) mark.run(Date.now(), session, entry.id);
  return pushes;
}

export function acknowledge(db: DatabaseSync, session: string, entry: number): void {
  db.prepare(
    `UPDATE deliveries SET intake = 'taken',
       state = iif(state IN ('pending', 'pushed'), 'acknowledged', state), updated_at = ?
     WHERE session = ? AND entry = ?`,
  ).run(Date.now(), session, entry);
}

export function defer(db: DatabaseSync, session: string, entry: number, until: number): void {
  db.prepare(
    `UPDATE deliveries SET intake = 'waiting', updated_at = ?
     WHERE session = ? AND entry = ? AND intake IN ('waiting', 'resent')`,
  ).run(until, session, entry);
}

const NOT_TAKEN = `SELECT d.session AS session, d.intake AS intake, s.role AS role, ${ENTRY_JSON} AS j
  FROM deliveries d JOIN sessions s ON s.id = d.session JOIN entries e ON e.id = d.entry
  WHERE d.intake IN ('waiting', 'resent') AND d.state <> 'pending'
    AND ((s.role = 'mate' AND s.state = 'idle')
      OR (s.role = 'worker' AND ${quietSql("s.state", "s.attempt")}))
    AND ?1 - max(d.updated_at, coalesce(s.last_seen, 0)) > ?2
  ORDER BY d.entry`;

function sender(author: string): string {
  if (author.startsWith("worker:")) return "the worker";
  if (author === "check" || author === "captain") return `the ${author}`;
  if (author.startsWith("job:")) return "the job";
  return author.replace(/^mate:/, "");
}

function escalate(db: DatabaseSync, session: string, role: string, entry: Entry): string[] {
  const what = `this ${entry.kind} from ${sender(entry.author)}`;
  const line = (entry.body.split("\n").find((each) => each.trim() !== "") ?? "").trim();
  const name = `c-${String(entry.card)}`;
  const worker = role === "worker";
  const who = worker ? `the worker on ${name}` : session;
  const body = `missed: ${who} did not take in ${what}, sent twice: ${line}`;
  const fields = {
    condition: "missed",
    entry: entry.id,
    ...(worker ? { worker: session } : { mate: session }),
  };
  const owner = worker ? getCard(db, entry.card).lane : parentOf(db, session);
  const to = owner === null ? [] : [owner];
  const kind = owner === null ? "note" : "finding";
  addEntry(db, { card: entry.card, author: "check", kind, body, fields }, to);
  return to;
}

export function chaseIntake(db: DatabaseSync, now: number, t: Timings): string[] {
  const resend = db.prepare(
    "UPDATE deliveries SET state = 'pending', intake = 'resent', updated_at = ? WHERE session = ? AND entry = ?",
  );
  const escalated = db.prepare(
    "UPDATE deliveries SET intake = 'escalated' WHERE session = ? AND entry = ?",
  );
  return db
    .prepare(NOT_TAKEN)
    .all(now, t.intake)
    .flatMap((row) => {
      const session = String(row["session"]);
      const entry = check(EntrySchema, JSON.parse(String(row["j"])));
      if (row["intake"] === "waiting") {
        resend.run(now, session, entry.id);
        return [session];
      }
      escalated.run(session, entry.id);
      return escalate(db, session, String(row["role"]), entry);
    });
}

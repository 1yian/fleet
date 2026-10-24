import type { DatabaseSync } from "node:sqlite";
import { check, EntrySchema, PushedEntrySchema, type Entry } from "@fleet/protocol";
import type { Draft } from "./change.ts";
import { LIVE_INCIDENT } from "./incident-store.ts";
import { addEntry, ENTRY_JSON, json, mainLane } from "./store.ts";
import type { Timings } from "./timing.ts";

export interface Push {
  readonly entry: Entry;
  readonly name: string;
  readonly mode: "steer" | "followUp";
  readonly again: boolean;
}

export function confirm(db: DatabaseSync, session: string, inFile: readonly number[]): number {
  const mark = db.prepare(
    "UPDATE deliveries SET state = 'confirmed', intake = 'taken', updated_at = ? WHERE session = ? AND entry = ?",
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

const QUIET_STATUSES: ReadonlySet<unknown> = new Set(["working", "paused", "note", "in-review"]);

function isRoutine(entry: Entry): boolean {
  if (entry.fields["routine"] === true) return true;
  return entry.kind === "report" && QUIET_STATUSES.has(entry.fields["status"]);
}

export interface Batching {
  readonly now: number;
  readonly window: number;
}

function releasable(db: DatabaseSync, session: string, batching: Batching): boolean {
  const row = db.prepare("SELECT batch_since AS since FROM sessions WHERE id = ?").get(session);
  const since = row?.["since"];
  if (typeof since !== "number") {
    db.prepare("UPDATE sessions SET batch_since = ? WHERE id = ?").run(batching.now, session);
    return false;
  }
  return batching.now - since >= batching.window;
}

export function dueBatches(db: DatabaseSync, batching: Batching): string[] {
  return db
    .prepare("SELECT id FROM sessions WHERE batch_since IS NOT NULL AND ?1 - batch_since >= ?2")
    .all(batching.now, batching.window)
    .map((row) => String(row["id"]));
}

export function toPush(
  db: DatabaseSync,
  session: string,
  atConnect: boolean,
  batching: Batching,
): Push[] {
  const states = atConnect ? "('pending', 'pushed', 'acknowledged')" : "('pending')";
  const rows = json(
    db,
    `SELECT json_object('entry', json(${ENTRY_JSON}), 'name', c.name,
       'again', json(iif(d.intake = 'resent', 'true', 'false'))) AS j
     FROM deliveries d JOIN entries e ON e.id = d.entry JOIN cards c ON c.id = e.card
     WHERE d.session = ? AND d.state IN ${states} ORDER BY e.id`,
    session,
  );
  const queued = new Set(
    db
      .prepare("SELECT entry FROM deliveries WHERE session = ? AND state = 'pending'")
      .all(session)
      .map((row) => Number(row["entry"])),
  );
  const all = rows.map((row) => {
    const { entry, name, again = false } = check(PushedEntrySchema, row);
    const push = {
      entry,
      name,
      again,
      mode: entry.fields["now"] === true ? "steer" : "followUp",
    } as const;
    return {
      push,
      held: queued.has(entry.id) && !again && entry.fields["now"] !== true && isRoutine(entry),
    };
  });
  const holding = all.some(({ held }) => held);
  const urgent = all.some(({ held }) => !held);
  const release = !holding || urgent || releasable(db, session, batching);
  if (release) db.prepare("UPDATE sessions SET batch_since = NULL WHERE id = ?").run(session);
  const pushes = all.filter(({ held }) => release || !held).map(({ push }) => push);
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

const UNREAD_RESENDS = 3;

const NOT_TAKEN = `SELECT d.session AS session, d.resends AS resends, d.told_at AS told, d.updated_at AS updated, s.role AS role, ${ENTRY_JSON} AS j
  FROM deliveries d JOIN sessions s ON s.id = d.session JOIN entries e ON e.id = d.entry
  WHERE d.intake IN ('waiting', 'resent') AND d.state <> 'pending'
    AND s.state IN ('idle', 'waiting')
    AND NOT ${LIVE_INCIDENT.replace("SESSION", "d.session")}
    AND (?1 - d.updated_at >= ?2 OR (d.resends >= ${String(UNREAD_RESENDS)} AND (d.told_at IS NULL OR ?1 - d.told_at >= ?3)))
  ORDER BY d.entry`;

function sender(author: string): string {
  if (author.startsWith("worker:")) return "the worker";
  if (author === "check" || author === "captain") return `the ${author}`;
  if (author.startsWith("job:")) return "the job";
  return author.replace(/^mate:/, "");
}

const heardUp = (db: DatabaseSync, lane: string): boolean =>
  db
    .prepare(
      "SELECT 1 FROM sessions WHERE id = ? AND role = 'mate' AND state IN ('starting', 'idle', 'running', 'waiting')",
    )
    .get(lane) !== undefined;

function tellOwner(
  db: DatabaseSync,
  session: string,
  role: string,
  entry: Entry,
  resends: number,
): string[] {
  const what = `this ${entry.kind} from ${sender(entry.author)}`;
  const line = (entry.body.split("\n").find((each) => each.trim() !== "") ?? "").trim();
  const name = `c-${String(entry.card)}`;
  const worker = role === "worker";
  const who = worker ? `the worker on ${name}` : session;
  const body = `missed: ${who} did not take in ${what}, re-sent ${String(resends)} times: ${line}`;
  const fields = {
    condition: "missed",
    entry: entry.id,
    ...(worker ? { worker: session } : { mate: session }),
  };
  const owner = mainLane(db);
  const to = owner === session || !heardUp(db, owner) ? [] : [owner];
  if (to.length === 0) return [];
  remind(
    db,
    { card: entry.card, author: "check", kind: "finding", body, fields },
    to,
    `unread:${String(entry.id)}`,
  );
  return to;
}

export function remind(
  db: DatabaseSync,
  draft: Draft,
  recipients: readonly string[],
  key: string,
): void {
  const retire = db.prepare(`DELETE FROM deliveries WHERE session = ? AND entry IN (
    SELECT id FROM entries WHERE card = ? AND author = 'check' AND json_extract(fields, '$.reminder') = ?)`);
  for (const recipient of recipients) retire.run(recipient, draft.card, key);
  addEntry(db, { ...draft, fields: { ...draft.fields, reminder: key } }, recipients);
}

export function chaseIntake(db: DatabaseSync, now: number, t: Timings): string[] {
  const resend = db.prepare(
    `UPDATE deliveries SET state = 'pending', intake = 'resent', resends = resends + 1, updated_at = ?
     WHERE session = ? AND entry = ?`,
  );
  const told = db.prepare("UPDATE deliveries SET told_at = ? WHERE session = ? AND entry = ?");
  return db
    .prepare(NOT_TAKEN)
    .all(now, t.intake, t.intakeTold)
    .flatMap((row) => {
      const session = String(row["session"]);
      const entry = check(EntrySchema, JSON.parse(String(row["j"])));
      const due = now - Number(row["updated"]) >= t.intake;
      const resends = Number(row["resends"]) + (due ? 1 : 0);
      const owed =
        resends >= UNREAD_RESENDS &&
        (typeof row["told"] !== "number" || now - row["told"] >= t.intakeTold);
      const heard = owed ? tellOwner(db, session, String(row["role"]), entry, resends) : [];
      if (heard.length > 0) told.run(now, session, entry.id);
      if (!due) return heard;
      resend.run(now, session, entry.id);
      return [session, ...heard];
    });
}

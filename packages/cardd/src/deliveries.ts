import type { DatabaseSync, StatementSync } from "node:sqlite";
import { check, EntrySchema, PushedEntrySchema, type Entry } from "@fleet/protocol";
import type { Draft } from "./change.ts";
import { LIVE_INCIDENT } from "./incident-store.ts";
import { addEntry, ENTRY_JSON, json, mainLane } from "./store.ts";
import { holdFor } from "./waits.ts";
import type { Timings } from "./timing.ts";

export interface Push {
  readonly entry: Entry;
  readonly name: string;
  readonly mode: "steer" | "followUp";
  readonly again: boolean;
}

const DELIVERY_STATES = [
  "pending",
  "pushed",
  "resent",
  "pushed-again",
  "filed",
  "acknowledged",
  "confirmed",
] as const;
type DeliveryState = (typeof DELIVERY_STATES)[number];
type DeliveryEvent = "push" | "ack" | "confirm" | "resend";

export const QUEUED_DELIVERY = "'pending', 'resent'";
export const UNTAKEN_DELIVERY = "'pending', 'pushed', 'resent', 'pushed-again', 'filed'";
export const TAKEN_DELIVERY = "'acknowledged', 'confirmed'";

const AT_CONNECT = "'pending', 'pushed', 'resent', 'pushed-again', 'acknowledged'";
const WHEN_UP = QUEUED_DELIVERY;
const AGAIN = "'resent', 'pushed-again'";
const CHASEABLE = "'pushed', 'pushed-again', 'filed'";

function deliveryState(value: unknown): DeliveryState {
  const found = DELIVERY_STATES.find((state) => state === value);
  if (found !== undefined) return found;
  throw new Error(`bad delivery state: ${JSON.stringify(value)}`);
}

function afterPush(state: DeliveryState): DeliveryState {
  switch (state) {
    case "pending":
      return "pushed";
    case "resent":
      return "pushed-again";
    case "pushed":
    case "pushed-again":
    case "filed":
    case "acknowledged":
    case "confirmed":
      return state;
    default: {
      const unreachable: never = state;
      throw new Error(unreachable);
    }
  }
}

function afterAck(state: DeliveryState): DeliveryState {
  switch (state) {
    case "filed":
    case "confirmed":
      return "confirmed";
    case "pending":
    case "pushed":
    case "resent":
    case "pushed-again":
    case "acknowledged":
      return "acknowledged";
    default: {
      const unreachable: never = state;
      throw new Error(unreachable);
    }
  }
}

function afterConfirm(state: DeliveryState): DeliveryState {
  switch (state) {
    case "acknowledged":
    case "confirmed":
      return "confirmed";
    case "pending":
    case "pushed":
    case "resent":
    case "pushed-again":
    case "filed":
      return "filed";
    default: {
      const unreachable: never = state;
      throw new Error(unreachable);
    }
  }
}

function afterResend(state: DeliveryState): DeliveryState {
  switch (state) {
    case "pushed":
    case "pushed-again":
    case "filed":
      return "resent";
    case "pending":
    case "resent":
    case "acknowledged":
    case "confirmed":
      return state;
    default: {
      const unreachable: never = state;
      throw new Error(unreachable);
    }
  }
}

function nextDelivery(state: DeliveryState, event: DeliveryEvent): DeliveryState {
  switch (event) {
    case "push":
      return afterPush(state);
    case "ack":
      return afterAck(state);
    case "confirm":
      return afterConfirm(state);
    case "resend":
      return afterResend(state);
    default: {
      const unreachable: never = event;
      throw new Error(unreachable);
    }
  }
}

function apply(
  read: StatementSync,
  write: StatementSync,
  session: string,
  entry: number,
  event: DeliveryEvent,
  now: number,
): void {
  const row = read.get(session, entry);
  if (row === undefined) return;
  write.run(nextDelivery(deliveryState(row["state"]), event), now, session, entry);
}

export function confirm(db: DatabaseSync, session: string, inFile: readonly number[]): void {
  const read = db.prepare("SELECT state FROM deliveries WHERE session = ? AND entry = ?");
  const write = db.prepare(
    "UPDATE deliveries SET state = ?, updated_at = ? WHERE session = ? AND entry = ?",
  );
  const now = Date.now();
  for (const entry of inFile) apply(read, write, session, entry, "confirm", now);
}

const QUIET_STATUSES: ReadonlySet<unknown> = new Set(["working", "paused", "note", "in-review"]);

function isSteer(entry: Entry): boolean {
  if (entry.kind !== "comment" || entry.fields["task"] === true) return false;
  if (entry.fields["later"] === true) return false;
  return entry.author.startsWith("mate:") || entry.author === "captain";
}

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
  const states = atConnect ? AT_CONNECT : WHEN_UP;
  const rows = json(
    db,
    `SELECT json_object('entry', json(${ENTRY_JSON}), 'name', c.name,
       'again', json(iif(d.state IN (${AGAIN}), 'true', 'false'))) AS j
     FROM deliveries d JOIN entries e ON e.id = d.entry JOIN cards c ON c.id = e.card
     WHERE d.session = ? AND d.state IN (${states}) ORDER BY e.id`,
    session,
  );
  const queued = new Set(
    db
      .prepare("SELECT entry FROM deliveries WHERE session = ? AND state = 'pending'")
      .all(session)
      .map((row) => Number(row["entry"])),
  );
  const lane = String(db.prepare("SELECT lane FROM sessions WHERE id = ?").get(session)?.["lane"]);
  const all = rows.map((row) => {
    const pushed = check(PushedEntrySchema, row);
    const { name, again = false } = pushed;
    const entry = holdFor(db, lane, pushed.entry);
    const push = {
      entry,
      name,
      again,
      mode: isSteer(entry) ? "steer" : "followUp",
    } as const;
    return {
      push,
      held: queued.has(entry.id) && !again && !isSteer(entry) && isRoutine(entry),
    };
  });
  const holding = all.some(({ held }) => held);
  const urgent = all.some(({ held }) => !held);
  const release = !holding || urgent || releasable(db, session, batching);
  if (release) db.prepare("UPDATE sessions SET batch_since = NULL WHERE id = ?").run(session);
  const pushes = all.filter(({ held }) => release || !held).map(({ push }) => push);
  const read = db.prepare("SELECT state FROM deliveries WHERE session = ? AND entry = ?");
  const write = db.prepare(
    "UPDATE deliveries SET state = ?, updated_at = ? WHERE session = ? AND entry = ?",
  );
  const now = Date.now();
  for (const { entry } of pushes) apply(read, write, session, entry.id, "push", now);
  return pushes;
}

export function acknowledge(db: DatabaseSync, session: string, entry: number): void {
  const read = db.prepare("SELECT state FROM deliveries WHERE session = ? AND entry = ?");
  const write = db.prepare(
    "UPDATE deliveries SET state = ?, updated_at = ? WHERE session = ? AND entry = ?",
  );
  apply(read, write, session, entry, "ack", Date.now());
}

const UNREAD_RESENDS = 3;

const CHASE_ROWS = `SELECT d.session AS session, d.state AS state, d.resends AS resends, d.told_at AS told, d.updated_at AS updated, s.role AS role, ${ENTRY_JSON} AS j
  FROM deliveries d JOIN sessions s ON s.id = d.session JOIN entries e ON e.id = d.entry
  WHERE d.state IN (${CHASEABLE})
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
    `UPDATE deliveries SET state = ?, resends = resends + 1, updated_at = ?
     WHERE session = ? AND entry = ?`,
  );
  const told = db.prepare("UPDATE deliveries SET told_at = ? WHERE session = ? AND entry = ?");
  return db
    .prepare(CHASE_ROWS)
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
      resend.run(nextDelivery(deliveryState(row["state"]), "resend"), now, session, entry.id);
      return [session, ...heard];
    });
}

const HOLDS_ON_UNREAD: ReadonlySet<unknown> = new Set(["working", "note"]);

export function requireCommentsRead(db: DatabaseSync, session: string, status: string): void {
  if (HOLDS_ON_UNREAD.has(status)) return;
  const rows = db
    .prepare(
      `SELECT e.author AS author, e.body AS body FROM deliveries d JOIN entries e ON e.id = d.entry
       WHERE d.session = ? AND d.state NOT IN (${TAKEN_DELIVERY}) AND e.kind = 'comment'
         AND json_extract(e.fields, '$.task') IS NULL
         AND json_extract(e.fields, '$.for') = 'worker'
       ORDER BY e.id`,
    )
    .all(session);
  if (rows.length === 0) return;
  const unread = rows
    .map((row) => `from ${sender(String(row["author"]))}: ${String(row["body"])}`)
    .join("\n");
  throw new Error(
    `this ${status} report does not count yet: you have ${String(rows.length)} unread comment(s) that the fleet is delivering to you now. Read them, act on them, answer with report(status="working", text=...), then send this report again if it still holds.\n${unread}`,
  );
}

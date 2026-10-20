// Reads and writes cards.db. A mate's session ID is its lane name. Rows leave the database as JSON built by SQLite and
// are checked against the protocol schemas, so the types match the wire.
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  CardSchema,
  check,
  EntrySchema,
  type Card,
  type Entry,
  type Status,
} from "@fleet/protocol";
import Type from "typebox";

export interface Session {
  readonly id: string;
  readonly role: "mate" | "worker";
  readonly lane: string;
  readonly card: number | null;
  readonly live: boolean;
}
const SessionSchema = Type.Object({
  id: Type.String(),
  role: Type.Enum(["mate", "worker"]),
  lane: Type.String(),
  card: Type.Union([Type.Integer(), Type.Null()]),
  live: Type.Boolean(),
});

const CARD_JSON = `json_object('id', id, 'title', title, 'lane', lane, 'project', project,
  'kind', kind, 'status', status, 'revision', revision, 'pr', pr, 'intent', intent, 'spec', spec,
  'createdAt', created_at, 'updatedAt', updated_at)`;
/** SQL that builds an entry's wire JSON from table alias `e`. */
export const ENTRY_JSON = `json_object('id', e.id, 'card', e.card, 'author', e.author, 'kind', e.kind,
  'body', e.body, 'fields', json(e.fields), 'createdAt', e.created_at)`;
const SESSION_JSON = `json_object('id', s.id, 'role', s.role, 'lane', s.lane, 'card', a.card,
  'live', json(iif(s.role = 'mate' OR a.state IN ('starting', 'active'), 'true', 'false')))`;

export const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The token of a session: the HMAC of its role and ID under the database's key. The same session gives the same token, and no mate can share a token with a worker. */
export function tokenFor(db: DatabaseSync, role: "mate" | "worker", session: string): string {
  db.prepare("INSERT OR IGNORE INTO secrets (name, value) VALUES ('token-key', ?)").run(
    randomBytes(32),
  );
  const key = db.prepare("SELECT value FROM secrets WHERE name = 'token-key'").get()?.["value"];
  if (!(key instanceof Uint8Array)) throw new Error("the token key is missing");
  return createHmac("sha256", key).update(`${role}:${session}`).digest("base64url");
}

/** Runs a query whose one column `j` is JSON, and parses each row. */
export function json(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): unknown[] {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => {
      const value = row["j"];
      if (typeof value !== "string") throw new Error("expected a JSON column named j");
      const parsed: unknown = JSON.parse(value);
      return parsed;
    });
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Adds a lane and its mate session. Returns the mate's token. */
export function addLane(
  db: DatabaseSync,
  lane: { name: string; home: string; parent?: string },
): string {
  if (/^c-\d+-a\d+$/.test(lane.name)) {
    throw new Error(`${lane.name} is the form of a worker session, so it cannot name a lane`);
  }
  const token = transaction(db, () => {
    const token = tokenFor(db, "mate", lane.name);
    db.prepare("INSERT INTO lanes (name, home, parent) VALUES (?, ?, ?)").run(
      lane.name,
      lane.home,
      lane.parent ?? null,
    );
    db.prepare(
      "INSERT INTO sessions (id, role, lane, host, token_hash, state) VALUES (?, 'mate', ?, '', ?, 'exited')",
    ).run(lane.name, lane.name, hash(token));
    return token;
  });
  return token;
}

export function addProject(
  db: DatabaseSync,
  project: { name: string; delivery: string; capacity: number; clones: Record<string, string> },
): void {
  db.prepare("INSERT INTO projects (name, delivery, capacity, clones) VALUES (?, ?, ?, ?)").run(
    project.name,
    project.delivery,
    project.capacity,
    JSON.stringify(project.clones),
  );
}

export function sessionByToken(db: DatabaseSync, token: string): Session | undefined {
  const sql = `SELECT ${SESSION_JSON} AS j FROM sessions s LEFT JOIN attempts a ON a.id = s.attempt
    WHERE s.token_hash = ?`;
  const [row] = json(db, sql, hash(token));
  return row === undefined ? undefined : check(SessionSchema, row);
}

export function getCard(db: DatabaseSync, id: number): Card {
  const [row] = json(db, `SELECT ${CARD_JSON} AS j FROM cards WHERE id = ?`, id);
  if (row === undefined) throw new Error(`no card c-${String(id)}`);
  return check(CardSchema, row);
}

export const listCards = (db: DatabaseSync): Card[] =>
  json(db, `SELECT ${CARD_JSON} AS j FROM cards ORDER BY id`).map((row) => check(CardSchema, row));

export const cardEntries = (db: DatabaseSync, card: number): Entry[] =>
  json(db, `SELECT ${ENTRY_JSON} AS j FROM entries e WHERE card = ? ORDER BY id`, card).map((row) =>
    check(EntrySchema, row),
  );

export function addCard(
  db: DatabaseSync,
  card: {
    lane: string;
    title: string;
    kind: Card["kind"];
    project?: string;
    intent?: string;
    spec?: string;
  },
): Card {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO cards (title, lane, project, kind, status, intent, spec, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    )
    .run(
      card.title,
      card.lane,
      card.project ?? null,
      card.kind,
      card.intent ?? "",
      card.spec ?? "",
      now,
      now,
    );
  return getCard(db, Number(lastInsertRowid));
}

export function setStatus(db: DatabaseSync, card: number, status: Status): void {
  db.prepare("UPDATE cards SET status = ?, updated_at = ? WHERE id = ? AND status <> ?").run(
    status,
    Date.now(),
    card,
    status,
  );
}

/** Writes an entry and a Pending delivery record for each recipient session. */
export function addEntry(
  db: DatabaseSync,
  entry: Pick<Entry, "card" | "author" | "kind" | "body" | "fields">,
  recipients: readonly string[],
): void {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO entries (card, author, kind, body, fields, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(entry.card, entry.author, entry.kind, entry.body, JSON.stringify(entry.fields), now);
  const deliver = db.prepare(
    "INSERT INTO deliveries (session, entry, state, updated_at) VALUES (?, ?, 'pending', ?)",
  );
  for (const session of recipients) deliver.run(session, lastInsertRowid, now);
}

/** The session of the card's live attempt, if there is one. */
export function workerOf(db: DatabaseSync, card: number): string | undefined {
  const row = db
    .prepare(
      `SELECT s.id FROM sessions s JOIN attempts a ON a.id = s.attempt
       WHERE a.card = ? AND a.state IN ('starting', 'active')`,
    )
    .get(card);
  const id = row?.["id"];
  return typeof id === "string" ? id : undefined;
}

export type SessionState = "idle" | "running" | "waiting" | "exited" | "lost";

/** Records a session state. A worker's first connect makes its attempt Active. */
export function setSessionState(db: DatabaseSync, session: string, state: SessionState): void {
  const now = Date.now();
  db.prepare("UPDATE sessions SET state = ?, last_seen = ? WHERE id = ? AND state <> 'closed'").run(
    state,
    now,
    session,
  );
  db.prepare(
    `UPDATE attempts SET state = 'active', updated_at = ?
     WHERE state = 'starting' AND id = (SELECT attempt FROM sessions WHERE id = ?)`,
  ).run(now, session);
  if (state === "running" || state === "idle") {
    db.prepare(
      `UPDATE cards SET last_activity = ?
       WHERE id = (SELECT a.card FROM sessions s JOIN attempts a ON a.id = s.attempt WHERE s.id = ?)`,
    ).run(now, session);
  }
}

/** Main's lane: the one lane with no parent. */
export function mainLane(db: DatabaseSync): string {
  const name = db
    .prepare("SELECT name FROM lanes WHERE parent IS NULL ORDER BY name LIMIT 1")
    .get()?.["name"];
  if (typeof name !== "string") throw new Error("there is no main lane");
  return name;
}

/** The project registry (spec section 6.4): each project, its delivery mode, base branch, and the hosts with a clone. */
export function listProjects(
  db: DatabaseSync,
): { name: string; delivery: string; base: string; hosts: string[] }[] {
  return db
    .prepare("SELECT name, delivery, default_base AS base, clones FROM projects ORDER BY name")
    .all()
    .map((row) => {
      const clones: unknown = JSON.parse(String(row["clones"]));
      const hosts = typeof clones === "object" && clones !== null ? Object.keys(clones) : [];
      return {
        name: String(row["name"]),
        delivery: String(row["delivery"]),
        base: String(row["base"]),
        hosts,
      };
    });
}

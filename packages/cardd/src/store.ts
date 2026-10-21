import { createHash, createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  ActivitySchema,
  CardSchema,
  check,
  DELIVERIES,
  EntrySchema,
  type Activity,
  type Card,
  type Delivery,
  type Entry,
} from "@fleet/protocol";
import Type from "typebox";
import { yoloFor } from "./authority.ts";
import { standingFrom, type Standing } from "./status.ts";

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

const CardRowSchema = Type.Omit(CardSchema, ["status", "updatedAt"]);
const CARD_JSON = `json_object('id', id, 'name', CASE name WHEN '' THEN 'c-' || id ELSE name END, 'title', title, 'lane', lane, 'project', project,
  'kind', kind, 'revision', revision, 'pr', pr, 'delivery', delivery, 'intent', intent, 'spec', spec,
  'createdAt', created_at)`;
const STREAM_KINDS: ReadonlySet<string> = new Set([
  "comment",
  "report",
  "hold",
  "release",
  "answer",
  "cleanup",
  "review-feedback",
]);
export const ENTRY_JSON = `json_object('id', e.id, 'card', e.card, 'author', e.author, 'kind', e.kind,
  'body', e.body, 'fields', json(e.fields), 'createdAt', e.created_at)`;
const SESSION_JSON = `json_object('id', s.id, 'role', s.role, 'lane', s.lane, 'card', a.card,
  'live', json(iif(s.role = 'mate' OR a.state IN ('starting', 'active'), 'true', 'false')))`;

export const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

export function tokenFor(db: DatabaseSync, role: "mate" | "worker", session: string): string {
  db.prepare("INSERT OR IGNORE INTO secrets (name, value) VALUES ('token-key', ?)").run(
    randomBytes(32),
  );
  const key = db.prepare("SELECT value FROM secrets WHERE name = 'token-key'").get()?.["value"];
  if (!(key instanceof Uint8Array)) throw new Error("the token key is missing");
  return createHmac("sha256", key).update(`${role}:${session}`).digest("base64url");
}

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
    if (lane.parent !== undefined) {
      const card = addCard(db, {
        lane: lane.name,
        title: lane.name,
        name: lane.name,
        kind: "standing",
      });
      db.prepare("UPDATE lanes SET card = ? WHERE name = ?").run(card.id, lane.name);
    }
    return token;
  });
  return token;
}

export function parentOf(db: DatabaseSync, lane: string): string | null {
  const parent = db.prepare("SELECT parent FROM lanes WHERE name = ?").get(lane)?.["parent"];
  return typeof parent === "string" ? parent : null;
}

export function laneCardOf(db: DatabaseSync, lane: string): number | undefined {
  const card = db.prepare("SELECT card FROM lanes WHERE name = ?").get(lane)?.["card"];
  return typeof card === "number" ? card : undefined;
}

export function reachable(
  db: DatabaseSync,
  session: Session,
  id: number,
): { card: Card; own: boolean } {
  const card = getCard(db, id);
  if (card.lane === session.lane) return { card, own: true };
  if (parentOf(db, card.lane) === session.lane) return { card, own: false };
  throw new Error(`c-${String(id)} belongs to lane ${card.lane}`);
}

export const isLaneCard = (db: DatabaseSync, card: Card): boolean =>
  laneCardOf(db, card.lane) === card.id;

export function addProject(
  db: DatabaseSync,
  project: {
    name: string;
    delivery: string;
    clones: Record<string, string>;
    yolo: boolean;
    repo: string | null;
  },
): void {
  db.prepare(
    "INSERT INTO projects (name, delivery, clones, yolo, repo) VALUES (?, ?, ?, ?, ?)",
  ).run(
    project.name,
    project.delivery,
    JSON.stringify(project.clones),
    project.yolo ? 1 : 0,
    project.repo,
  );
}

export function setClone(db: DatabaseSync, project: string, host: string, path: string): void {
  const { changes } = db
    .prepare(`UPDATE projects SET clones = json_set(clones, '$."' || ? || '"', ?) WHERE name = ?`)
    .run(host, path, project);
  if (changes === 0) throw new Error(`project ${project} is not in the registry`);
}

export function setYolo(db: DatabaseSync, project: string, yolo: boolean): void {
  const { changes } = db
    .prepare("UPDATE projects SET yolo = ? WHERE name = ?")
    .run(yolo ? 1 : 0, project);
  if (changes === 0) throw new Error(`project ${project} is not in the registry`);
}

export function setRepo(db: DatabaseSync, project: string, repo: string): void {
  const { changes } = db.prepare("UPDATE projects SET repo = ? WHERE name = ?").run(repo, project);
  if (changes === 0) throw new Error(`project ${project} is not in the registry`);
}

export function sessionByToken(db: DatabaseSync, token: string): Session | undefined {
  const sql = `SELECT ${SESSION_JSON} AS j FROM sessions s LEFT JOIN attempts a ON a.id = s.attempt
    WHERE s.token_hash = ?`;
  const [row] = json(db, sql, hash(token));
  return row === undefined ? undefined : check(SessionSchema, row);
}

export interface Loaded {
  readonly card: Card;
  readonly entries: Entry[];
  readonly standing: Standing;
}

function loaded(db: DatabaseSync, row: unknown, now: number): Loaded {
  const base = check(CardRowSchema, row);
  const entries = cardEntries(db, base.id);
  const yolo = yoloFor(db, base.id);
  const basis = { kind: base.kind, yolo, createdAt: base.createdAt };
  const standing = standingFrom(basis, entries, now);
  const card = { ...base, status: standing.status, updatedAt: standing.since };
  return { card, entries, standing };
}

export function loadCard(db: DatabaseSync, id: number): Loaded {
  const [row] = json(db, `SELECT ${CARD_JSON} AS j FROM cards WHERE id = ?`, id);
  if (row === undefined) throw new Error(`no card c-${String(id)}`);
  return loaded(db, row, Date.now());
}

export function loadCards(db: DatabaseSync): Loaded[] {
  const now = Date.now();
  return json(db, `SELECT ${CARD_JSON} AS j FROM cards ORDER BY id`).map((row) =>
    loaded(db, row, now),
  );
}

export const getCard = (db: DatabaseSync, id: number): Card => loadCard(db, id).card;

export const cardEntries = (db: DatabaseSync, card: number): Entry[] =>
  json(db, `SELECT ${ENTRY_JSON} AS j FROM entries e WHERE card = ? ORDER BY id`, card).map((row) =>
    check(EntrySchema, row),
  );

function nameFrom(title: string): string {
  const words = title.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, 4).join("-").slice(0, 40).replace(/-+$/, "");
}

export function registeredDelivery(db: DatabaseSync, project: string): Delivery {
  const mode = db.prepare("SELECT delivery FROM projects WHERE name = ?").get(project)?.[
    "delivery"
  ];
  return DELIVERIES.find((each) => each === mode) ?? "no-mistakes";
}

export function addCard(
  db: DatabaseSync,
  card: {
    lane: string;
    title: string;
    name?: string;
    kind: Card["kind"];
    project?: string;
    intent?: string;
    spec?: string;
  },
): Card {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO cards (title, name, lane, project, kind, delivery, intent, spec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      card.title,
      card.name ?? nameFrom(card.title),
      card.lane,
      card.project ?? null,
      card.kind,
      card.kind === "ship" && card.project !== undefined
        ? registeredDelivery(db, card.project)
        : null,
      card.intent ?? "",
      card.spec ?? "",
      now,
    );
  return getCard(db, Number(lastInsertRowid));
}

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
  if (STREAM_KINDS.has(entry.kind))
    db.prepare("UPDATE cards SET revision = revision + 1 WHERE id = ?").run(entry.card);
  const deliver = db.prepare(
    "INSERT INTO deliveries (session, entry, state, updated_at) VALUES (?, ?, 'pending', ?)",
  );
  for (const session of recipients) deliver.run(session, lastInsertRowid, now);
}

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

export function activityOf(db: DatabaseSync, card: Card, lane: boolean): Activity | null {
  if (card.status === "done" || card.status === "dropped") return null;
  const row = lane
    ? db
        .prepare(
          `SELECT state, coalesce(last_seen, 0) AS at FROM sessions
           WHERE role = 'mate' AND lane = ? AND state <> 'closed'`,
        )
        .get(card.lane)
    : db
        .prepare(
          `SELECT s.state AS state, coalesce(s.last_seen, a.created_at) AS at
           FROM sessions s JOIN attempts a ON a.id = s.attempt
           WHERE a.card = ? AND a.state IN ('starting', 'active') AND s.state <> 'closed'`,
        )
        .get(card.id);
  return row === undefined ? null : check(ActivitySchema, row);
}

export type SessionState = "idle" | "running" | "waiting" | "exited" | "lost";

export function setSessionState(db: DatabaseSync, session: string, state: SessionState): boolean {
  const now = Date.now();
  const before = db.prepare("SELECT state FROM sessions WHERE id = ?").get(session)?.["state"];
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
  return before !== state;
}

export function mainLane(db: DatabaseSync): string {
  const name = db
    .prepare("SELECT name FROM lanes WHERE parent IS NULL ORDER BY name LIMIT 1")
    .get()?.["name"];
  if (typeof name !== "string") throw new Error("there is no main lane");
  return name;
}

interface Project {
  readonly name: string;
  readonly delivery: string;
  readonly base: string;
  readonly clones: { host: string; path: string }[];
  readonly yolo: boolean;
}

export function listProjects(db: DatabaseSync): Project[] {
  return db
    .prepare(
      "SELECT name, delivery, default_base AS base, clones, yolo FROM projects ORDER BY name",
    )
    .all()
    .map((row) => {
      const clones: unknown = JSON.parse(String(row["clones"]));
      const paths = typeof clones === "object" && clones !== null ? Object.entries(clones) : [];
      return {
        name: String(row["name"]),
        delivery: String(row["delivery"]),
        base: String(row["base"]),
        clones: paths.map(([host, path]) => ({ host, path: String(path) })),
        yolo: row["yolo"] === 1,
      };
    });
}

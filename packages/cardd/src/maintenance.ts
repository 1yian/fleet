import type { DatabaseSync } from "node:sqlite";
import {
  check,
  MaintenanceSchema,
  maintenanceLine,
  type Maintenance,
  type OpArgs,
} from "@fleet/protocol";
import { json, laneCardOf, addEntry, type Session } from "./store.ts";
import type { Timings } from "./timing.ts";

const SELECT = `SELECT json_object('id', m.id, 'batch', m.batch, 'session', m.session,
  'lane', s.lane, 'role', s.role, 'host', s.host, 'kind', m.kind,
  'state', m.state, 'detail', m.detail) AS j
  FROM maintenance m JOIN sessions s ON s.id = m.session`;

const rowsOf = (db: DatabaseSync, where: string, ...params: (string | number)[]): Maintenance[] =>
  json(db, `${SELECT} WHERE ${where} ORDER BY m.id`, ...params).map((row) =>
    check(MaintenanceSchema, row),
  );

export const pendingFor = (db: DatabaseSync, session: string): Maintenance[] =>
  rowsOf(
    db,
    "m.session = ? AND m.state = 'pending' AND s.maintenance = 1 AND s.state IN ('idle', 'running', 'waiting')",
    session,
  );

const TERMINAL = "('completed', 'failed')";

function cardOf(db: DatabaseSync, session: string): number | undefined {
  const row = db
    .prepare(
      "SELECT s.lane AS lane, s.role AS role, a.card AS card FROM sessions s LEFT JOIN attempts a ON a.id = s.attempt WHERE s.id = ?",
    )
    .get(session);
  if (row?.["role"] === "worker") return Number(row["card"]);
  return typeof row?.["lane"] === "string" ? laneCardOf(db, row["lane"]) : undefined;
}

function settle(
  db: DatabaseSync,
  id: number,
  state: "completed" | "failed",
  detail: string,
): string[] {
  const now = Date.now();
  const changed = db
    .prepare(
      `UPDATE maintenance SET state = ?, detail = ?, updated_at = ? WHERE id = ? AND state NOT IN ${TERMINAL}`,
    )
    .run(state, detail, now, id);
  if (changed.changes === 0) return [];
  const [row] = rowsOf(db, "m.id = ?", id);
  const owner = db.prepare("SELECT requester, session FROM maintenance WHERE id = ?").get(id);
  const card = cardOf(db, String(owner?.["session"]));
  if (row === undefined || card === undefined) return [];
  const requester = String(owner?.["requester"]);
  const body = maintenanceLine({ ...row, state, detail });
  const quiet = state === "completed";
  const fields = { maintenance: id, batch: row.batch, kind: row.kind, state, quiet };
  addEntry(db, { card, author: "maintenance", kind: "note", body, fields }, [requester]);
  return [requester];
}

export function adoptMaintenance(
  db: DatabaseSync,
  session: string,
  process: string | undefined,
  supported: boolean,
): string[] {
  db.prepare("UPDATE sessions SET maintenance = ? WHERE id = ?").run(Number(supported), session);
  if (process === undefined) return [];
  const moved = db
    .prepare(
      `SELECT id FROM maintenance WHERE session = ? AND process IS NOT ?
       AND (state = 'reloading' OR (state = 'pending' AND kind = 'reload'))`,
    )
    .all(session, process);
  return moved.flatMap((row) =>
    settle(db, Number(row["id"]), "completed", "reconnected on a new process"),
  );
}

export function expireMaintenance(db: DatabaseSync, now: number, t: Timings): string[] {
  const reloading = db
    .prepare("SELECT id FROM maintenance WHERE state = 'reloading' AND ? - updated_at > ?")
    .all(now, t.verify);
  const absent = db
    .prepare(
      `SELECT m.id AS id FROM maintenance m JOIN sessions s ON s.id = m.session
       WHERE m.state = 'pending' AND s.state IN ('exited', 'lost') AND ? - m.updated_at > ?`,
    )
    .all(now, t.notConnected);
  return [
    ...reloading.flatMap((row) =>
      settle(db, Number(row["id"]), "failed", "it did not reconnect after it was reloaded"),
    ),
    ...absent.flatMap((row) =>
      settle(db, Number(row["id"]), "failed", "it did not reconnect, so it was left as it is"),
    ),
  ];
}

interface Target {
  readonly id: string;
  readonly role: "mate" | "worker";
  readonly connected: boolean;
  readonly supported: boolean;
  readonly process: string | null;
  readonly seen: number;
}

function targets(db: DatabaseSync, requester: string, kind: string): Target[] {
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.role AS role, s.process AS process, s.maintenance AS supported, coalesce(s.last_seen, 0) AS seen,
         s.state IN ('idle', 'running', 'waiting') AS connected
       FROM sessions s LEFT JOIN attempts a ON a.id = s.attempt
       WHERE s.id != ? AND s.stopping = 0 AND s.state NOT IN ('starting', 'closed')
         AND (s.role = 'mate' OR a.state = 'active')
         AND (? = 'reload' OR s.role = 'mate')
       ORDER BY s.role DESC, s.id`,
    )
    .all(requester, kind);
  return rows.map((row) => ({
    id: String(row["id"]),
    role: row["role"] === "mate" ? "mate" : "worker",
    connected: row["connected"] === 1,
    supported: row["supported"] === 1,
    process: typeof row["process"] === "string" ? row["process"] : null,
    seen: Number(row["seen"]),
  }));
}

function outcome(
  target: Target,
  now: number,
  t: Timings,
): { state: "pending" | "failed"; detail: string } {
  if (!target.connected && now - target.seen <= t.notConnected)
    return { state: "pending", detail: "reconnecting: the request waits for it to connect" };
  if (!target.connected)
    return {
      state: "failed",
      detail: "not connected (stopped, held, or down), so it was left as it is",
    };
  if (!target.supported)
    return {
      state: "failed",
      detail: "runs code from before safe reloads, so it was left running: restart it by hand",
    };
  return {
    state: "pending",
    detail: "waiting for a safe point: its turn and any job finish first",
  };
}

export function requestMaintenance(
  db: DatabaseSync,
  caller: Session,
  raw: OpArgs<"maintenance.request">,
  t: Timings,
): { value: Maintenance[]; notify: string[] } {
  if (caller.lane !== "main") throw new Error("only main can ask the fleet to reload or stow");
  const now = Date.now();
  const notify: string[] = [];
  for (const target of targets(db, caller.id, raw.kind)) {
    const open = db
      .prepare(
        "SELECT id FROM maintenance WHERE session = ? AND kind = ? AND state IN ('pending', 'reloading')",
      )
      .get(target.id, raw.kind);
    if (open !== undefined) {
      db.prepare("UPDATE maintenance SET batch = ?, requester = ? WHERE id = ? AND batch != ?").run(
        raw.batch,
        caller.id,
        Number(open["id"]),
        raw.batch,
      );
      notify.push(target.id);
      continue;
    }
    const { state, detail } = outcome(target, now, t);
    db.prepare(
      `INSERT OR IGNORE INTO maintenance (batch, requester, session, kind, state, process, detail, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(raw.batch, caller.id, target.id, raw.kind, state, target.process, detail, now);
    if (state === "pending") notify.push(target.id);
  }
  return { value: rowsOf(db, "m.batch = ?", raw.batch), notify };
}

export function maintenanceStatus(db: DatabaseSync, batch: string): Maintenance[] {
  return rowsOf(db, "m.batch = ?", batch);
}

export function acknowledgeMaintenance(
  db: DatabaseSync,
  caller: Session,
  args: OpArgs<"maintenance.ack">,
): { value: Maintenance; notify: string[] } {
  const open = db
    .prepare(
      "SELECT id FROM maintenance WHERE id = ? AND session = ? AND state IN ('pending', 'reloading')",
    )
    .get(args.id, caller.id);
  const notify =
    open === undefined
      ? []
      : args.state === "failed"
        ? settle(db, args.id, "failed", args.detail)
        : (db
            .prepare("UPDATE maintenance SET state = ?, detail = ?, updated_at = ? WHERE id = ?")
            .run(args.state, args.detail, Date.now(), args.id),
          []);
  const [value] = rowsOf(db, "m.id = ? AND m.session = ?", args.id, caller.id);
  if (value === undefined) throw new Error(`maintenance request ${String(args.id)} is not yours`);
  return { value, notify };
}

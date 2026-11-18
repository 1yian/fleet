import type { DatabaseSync } from "node:sqlite";
import {
  check,
  MaintenanceSchema,
  maintenanceLine,
  type Maintenance,
  type OpArgs,
} from "@fleet/protocol";
import { sanitize } from "./incident-kinds.ts";
import { stopOf, untilOf } from "./lane-stop.ts";
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

const batchRows = (db: DatabaseSync, batch: string): Maintenance[] =>
  rowsOf(
    db,
    "m.batch = ? OR m.id IN (SELECT maintenance FROM maintenance_batches WHERE batch = ?)",
    batch,
    batch,
  ).map((row) => ({ ...row, batch }));

function cardOf(db: DatabaseSync, session: string): number | undefined {
  const row = db
    .prepare(
      "SELECT s.lane AS lane, s.role AS role, a.card AS card FROM sessions s LEFT JOIN attempts a ON a.id = s.attempt WHERE s.id = ?",
    )
    .get(session);
  if (row?.["role"] === "worker") return Number(row["card"]);
  return typeof row?.["lane"] === "string" ? laneCardOf(db, row["lane"]) : undefined;
}

const summarized = (db: DatabaseSync, batch: string): boolean =>
  db
    .prepare(
      "SELECT 1 FROM entries WHERE author = 'maintenance' AND json_extract(fields, '$.maintenanceBatch') = ?",
    )
    .get(batch) !== undefined;

interface Member {
  readonly host: string;
  readonly state: "pending" | "reloading" | "completed" | "failed" | "removed";
}

const tally = (members: readonly Member[]): string => {
  const count = (state: Member["state"]): number =>
    members.filter((member) => member.state === state).length;
  const removed = count("removed");
  const gone = removed === 0 ? "" : `, ${String(removed)} removed with their lane`;
  return `${String(count("completed"))} reloaded and verified, ${String(count("failed"))} failed${gone}`;
};

function summarize(db: DatabaseSync, batch: string, requester: string): string[] {
  const live = batchRows(db, batch);
  const members: Member[] = [
    ...live,
    ...db
      .prepare("SELECT gone, host FROM maintenance_batches WHERE batch = ? AND maintenance IS NULL")
      .all(batch)
      .map((row): Member => {
        const state = row["gone"];
        return {
          host: String(row["host"]),
          state: state === "completed" || state === "failed" ? state : "removed",
        };
      }),
  ];
  const anchor = live.find((row) => row.state === "completed") ?? live[0];
  const card = anchor === undefined ? undefined : cardOf(db, anchor.session);
  if (
    card === undefined ||
    members.some((member) => member.state === "pending" || member.state === "reloading") ||
    !members.some((member) => member.state === "completed") ||
    summarized(db, batch)
  )
    return [];
  const hosts = [...new Set(members.map((member) => member.host))].sort();
  const body = [
    `Reload batch ${batch} finished: ${tally(members)}; 0 pending. Failures and removals are not verified successes.`,
    ...hosts.map(
      (host) =>
        `- ${host === "" ? "host unknown" : host}: ${tally(members.filter((member) => member.host === host))}`,
    ),
    "Individual receipts remain in each card's history; failures are reported separately.",
  ].join("\n");
  addEntry(
    db,
    {
      card,
      author: "maintenance",
      kind: "note",
      body,
      fields: {
        maintenance: "batch",
        maintenanceBatch: batch,
        kind: "reload",
        state: "completed",
        quiet: false,
      },
    },
    [requester],
  );
  return [requester];
}

function identityOf(row: Maintenance, card: number, process: unknown): string {
  const host = row.host === "" ? "unknown" : row.host;
  const id = typeof process === "string" ? process : "unknown";
  return ` [c-${String(card)}, host ${host}, process ${id}]`;
}

function receipt(db: DatabaseSync, id: number): string[] {
  const [row] = rowsOf(db, "m.id = ?", id);
  const owner = db
    .prepare("SELECT requester, session, process FROM maintenance WHERE id = ?")
    .get(id);
  const card = cardOf(db, String(owner?.["session"]));
  if (row === undefined || card === undefined) return [];
  const requester = String(owner?.["requester"]);
  const failedReload = row.state === "failed" && row.kind === "reload";
  const identity = failedReload ? identityOf(row, card, owner?.["process"]) : "";
  const body = `${maintenanceLine(row)}${identity}`;
  const quiet = row.state === "completed";
  const fields = { maintenance: id, batch: row.batch, kind: row.kind, state: row.state, quiet };
  const recipients = quiet && row.kind === "reload" ? [] : [requester];
  addEntry(db, { card, author: "maintenance", kind: "note", body, fields }, recipients);
  return recipients;
}

function name(db: DatabaseSync, id: number, process: string | null): void {
  const [row] = rowsOf(db, "m.id = ?", id);
  const card = row === undefined ? undefined : cardOf(db, row.session);
  if (row === undefined || card === undefined) return;
  db.prepare("UPDATE maintenance SET detail = ? WHERE id = ?").run(
    `${row.detail}${identityOf(row, card, process)}`,
    id,
  );
}

function settle(
  db: DatabaseSync,
  id: number,
  state: "completed" | "failed",
  detail: string,
): string[] {
  const changed = db
    .prepare(
      `UPDATE maintenance SET state = ?, detail = ?, updated_at = ? WHERE id = ? AND state NOT IN ${TERMINAL}`,
    )
    .run(state, detail, Date.now(), id);
  if (changed.changes === 0) return [];
  const batches = db
    .prepare("SELECT batch, requester FROM maintenance_batches WHERE maintenance = ?")
    .all(id);
  return [
    ...receipt(db, id),
    ...batches.flatMap((batch) =>
      summarize(db, String(batch["batch"]), String(batch["requester"])),
    ),
  ];
}

export function dropMaintenance(db: DatabaseSync, lane: string): string[] {
  const batches = db
    .prepare(
      `SELECT DISTINCT b.batch AS batch, b.requester AS requester FROM maintenance_batches b
       JOIN maintenance m ON m.id = b.maintenance WHERE m.session = ? AND b.requester != ?`,
    )
    .all(lane, lane);
  db.prepare(
    `UPDATE maintenance_batches SET host = coalesce((SELECT host FROM sessions WHERE id = ?), ''),
       gone = (SELECT CASE WHEN m.state IN ('completed', 'failed') THEN m.state ELSE 'removed' END
               FROM maintenance m WHERE m.id = maintenance_batches.maintenance),
       maintenance = NULL
     WHERE requester != ? AND maintenance IN (SELECT id FROM maintenance WHERE session = ?)`,
  ).run(lane, lane, lane);
  db.prepare(
    "DELETE FROM maintenance_batches WHERE requester = ? OR maintenance IN (SELECT id FROM maintenance WHERE requester = ?)",
  ).run(lane, lane);
  db.prepare("DELETE FROM maintenance WHERE session = ? OR requester = ?").run(lane, lane);
  return batches.flatMap((batch) =>
    summarize(db, String(batch["batch"]), String(batch["requester"])),
  );
}

export function settleClosedCard(db: DatabaseSync, card: number): string[] {
  const open = db
    .prepare(
      `SELECT m.id AS id FROM maintenance m JOIN sessions s ON s.id = m.session
       JOIN attempts a ON a.id = s.attempt
       WHERE a.card = ? AND m.state IN ('pending', 'reloading')`,
    )
    .all(card);
  return open.flatMap((row) =>
    settle(db, Number(row["id"]), "failed", "its card was closed, so it was left as it is"),
  );
}

export function adoptMaintenance(
  db: DatabaseSync,
  session: string,
  started: boolean,
  supported: boolean,
): string[] {
  db.prepare("UPDATE sessions SET maintenance = ? WHERE id = ?").run(Number(supported), session);
  if (!started) return [];
  const open = db
    .prepare("SELECT id FROM maintenance WHERE session = ? AND state = 'reloading'")
    .all(session);
  return open.flatMap((row) =>
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

function targets(db: DatabaseSync, requester: string, kind: string, now: number): Target[] {
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.role AS role, s.process AS process, s.maintenance AS supported, coalesce(s.last_seen, 0) AS seen,
         s.stopping_until AS until, s.state IN ('idle', 'running', 'waiting') AS connected
       FROM sessions s LEFT JOIN attempts a ON a.id = s.attempt
       WHERE s.id != ? AND s.state NOT IN ('starting', 'closed')
         AND (s.role = 'mate' OR a.state = 'active')
         AND (? = 'reload' OR s.role = 'mate')
       ORDER BY s.role DESC, s.id`,
    )
    .all(requester, kind)
    .filter((row) => stopOf(untilOf(row), now).kind === "up");
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

function attach(
  db: DatabaseSync,
  batch: string,
  requester: string,
  kind: Maintenance["kind"],
  id: number,
): void {
  if (kind === "reload")
    db.prepare(
      "INSERT INTO maintenance_batches (batch, requester, maintenance) VALUES (?, ?, ?)",
    ).run(batch, requester, id);
  else
    db.prepare("UPDATE maintenance SET batch = ?, requester = ? WHERE id = ? AND batch != ?").run(
      batch,
      requester,
      id,
      batch,
    );
}

function requestTarget(
  db: DatabaseSync,
  caller: Session,
  raw: OpArgs<"maintenance.request">,
  target: Target,
  t: Timings,
): string[] {
  const member = db
    .prepare(
      "SELECT 1 FROM maintenance_batches b JOIN maintenance m ON m.id = b.maintenance WHERE b.batch = ? AND m.session = ?",
    )
    .get(raw.batch, target.id);
  if (member !== undefined) return [];
  const open = db
    .prepare(
      "SELECT id FROM maintenance WHERE session = ? AND kind = ? AND state IN ('pending', 'reloading')",
    )
    .get(target.id, raw.kind);
  if (open !== undefined) {
    attach(db, raw.batch, caller.id, raw.kind, Number(open["id"]));
    return [target.id];
  }
  const { state, detail } = outcome(target, Date.now(), t);
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO maintenance (batch, requester, session, kind, state, process, detail, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(raw.batch, caller.id, target.id, raw.kind, state, target.process, detail, Date.now());
  if (inserted.changes === 0) return [];
  const id = Number(inserted.lastInsertRowid);
  attach(db, raw.batch, caller.id, raw.kind, id);
  if (state === "pending") return [target.id];
  if (raw.kind === "reload") name(db, id, target.process);
  return [];
}

export function requestMaintenance(
  db: DatabaseSync,
  caller: Session,
  raw: OpArgs<"maintenance.request">,
  t: Timings,
): { value: Maintenance[]; notify: string[] } {
  if (caller.lane !== "main") throw new Error("only main can ask the fleet to reload or stow");
  if (summarized(db, raw.batch)) return { value: batchRows(db, raw.batch), notify: [] };
  const notify = targets(db, caller.id, raw.kind, t.wall()).flatMap((target) =>
    requestTarget(db, caller, raw, target, t),
  );
  return { value: batchRows(db, raw.batch), notify };
}

export function maintenanceStatus(
  db: DatabaseSync,
  caller: Session,
  args: OpArgs<"maintenance.status">,
): { value: Maintenance[]; notify: string[] } {
  if (caller.lane !== "main")
    throw new Error("only the requester can read a batch or end reload verification");
  const notify =
    args.failUnverified === true
      ? batchRows(db, args.batch)
          .filter((row) => row.state === "reloading")
          .flatMap((row) =>
            settle(
              db,
              row.id,
              "failed",
              "no replacement hello before the update verification deadline",
            ),
          )
      : [];
  return { value: batchRows(db, args.batch), notify };
}

export function readMaintenance(db: DatabaseSync, caller: Session, id: number): Maintenance {
  const [value] = rowsOf(db, "m.id = ? AND m.session = ?", id, caller.id);
  if (value === undefined) throw new Error(`maintenance request ${String(id)} is not yours`);
  return value;
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
        ? settle(db, args.id, "failed", sanitize(args.detail))
        : (db
            .prepare("UPDATE maintenance SET state = ?, detail = ?, updated_at = ? WHERE id = ?")
            .run(args.state, args.detail, Date.now(), args.id),
          []);
  return { value: readMaintenance(db, caller, args.id), notify };
}

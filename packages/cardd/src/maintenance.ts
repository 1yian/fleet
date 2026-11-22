import type { DatabaseSync } from "node:sqlite";
import {
  check,
  MaintenanceSchema,
  maintenanceLine,
  type Entry,
  type Maintenance,
  type OpArgs,
} from "@fleet/protocol";
import { sanitize } from "./incident-kinds.ts";
import { outcome, targets, UNSUPPORTED, type Scope, type Target } from "./maintenance-targets.ts";
import { json, laneCardOf, addEntry, mainLane, type Session } from "./store.ts";
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

const IN_FLIGHT =
  "an earlier update's reload was already in progress, so this update could not verify it";

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

const summarized = (db: DatabaseSync, batch: string, card: number): boolean =>
  db
    .prepare(
      "SELECT 1 FROM entries WHERE card = ? AND author = 'maintenance' AND json_extract(fields, '$.maintenanceBatch') = ?",
    )
    .get(card, batch) !== undefined;

interface Member {
  readonly host: string;
  readonly state: Maintenance["state"] | "removed";
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
      .map((row): Member => ({
        host: String(row["host"]),
        state: row["gone"] === "failed" ? "failed" : "removed",
      })),
  ];
  const anchor = live.find((row) => row.state === "completed");
  const card = anchor === undefined ? undefined : cardOf(db, anchor.session);
  if (
    card === undefined ||
    members.some((member) => member.state === "pending" || member.state === "reloading") ||
    summarized(db, batch, card)
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
      fields: { maintenance: "batch", maintenanceBatch: batch },
    },
    [requester],
  );
  return [requester];
}

function identityOf(row: Maintenance, card: number, runtime: unknown): string {
  const host = row.host === "" ? "unknown" : row.host;
  const id = typeof runtime === "string" ? runtime : "unknown";
  return ` [c-${String(card)}, host ${host}, process ${id}]`;
}

export function identified(db: DatabaseSync, lane: string, entry: Entry): Entry {
  const id = entry.fields["maintenance"];
  if (entry.fields["state"] !== "failed" || entry.fields["kind"] !== "reload") return entry;
  if (typeof id !== "number" || lane !== mainLane(db)) return entry;
  const [row] = rowsOf(db, "m.id = ?", id);
  if (row === undefined) return entry;
  const runtime = db.prepare("SELECT runtime FROM maintenance WHERE id = ?").get(id)?.["runtime"];
  return { ...entry, body: `${entry.body}${identityOf(row, entry.card, runtime)}` };
}

function receipt(db: DatabaseSync, id: number): string[] {
  const [row] = rowsOf(db, "m.id = ?", id);
  const owner = db.prepare("SELECT requester, session FROM maintenance WHERE id = ?").get(id);
  const card = cardOf(db, String(owner?.["session"]));
  if (row === undefined || card === undefined) return [];
  const requester = String(owner?.["requester"]);
  const grouped =
    db
      .prepare("SELECT 1 FROM maintenance_batches WHERE maintenance = ? AND batch = ?")
      .get(id, row.batch) !== undefined;
  const quiet = row.state === "completed";
  const fields = { maintenance: id, batch: row.batch, kind: row.kind, state: row.state, quiet };
  const recipients = quiet && grouped ? [] : [requester];
  addEntry(
    db,
    { card, author: "maintenance", kind: "note", body: maintenanceLine(row), fields },
    recipients,
  );
  return recipients;
}

function projected(db: DatabaseSync, rows: readonly Maintenance[]): Maintenance[] {
  return rows.map((row) => {
    const card =
      row.state === "failed" && row.kind === "reload" ? cardOf(db, row.session) : undefined;
    if (card === undefined) return row;
    const runtime = db.prepare("SELECT runtime FROM maintenance WHERE id = ?").get(row.id)?.[
      "runtime"
    ];
    return { ...row, detail: `${row.detail}${identityOf(row, card, runtime)}` };
  });
}

function actor(db: DatabaseSync, id: number, session: string): void {
  db.prepare(
    "UPDATE maintenance SET runtime = (SELECT runtime FROM sessions WHERE id = ?) WHERE id = ?",
  ).run(session, id);
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

export function dropMaintenance(db: DatabaseSync, lane: string): void {
  const batches = db
    .prepare(
      `SELECT DISTINCT b.batch AS batch, b.requester AS requester FROM maintenance_batches b
       JOIN maintenance m ON m.id = b.maintenance WHERE m.session = ? AND b.requester != ?`,
    )
    .all(lane, lane);
  db.prepare(
    `INSERT INTO maintenance_batches (batch, requester, gone, host)
     SELECT m.batch, m.requester, CASE WHEN m.state = 'failed' THEN 'failed' ELSE 'removed' END,
       coalesce((SELECT host FROM sessions WHERE id = ?1), '')
     FROM maintenance m
     WHERE m.session = ?1 AND m.requester != ?1 AND m.kind = 'reload'
       AND NOT EXISTS (
         SELECT 1 FROM maintenance_batches b WHERE b.batch = m.batch AND b.maintenance = m.id
       )`,
  ).run(lane);
  db.prepare(
    `UPDATE maintenance_batches SET host = coalesce((SELECT host FROM sessions WHERE id = ?), ''),
       gone = (SELECT CASE WHEN m.state = 'failed' THEN 'failed' ELSE 'removed' END
               FROM maintenance m WHERE m.id = maintenance_batches.maintenance),
       maintenance = NULL
     WHERE requester != ? AND maintenance IN (SELECT id FROM maintenance WHERE session = ?)`,
  ).run(lane, lane, lane);
  db.prepare(
    "DELETE FROM maintenance_batches WHERE requester = ? OR maintenance IN (SELECT id FROM maintenance WHERE requester = ?)",
  ).run(lane, lane);
  db.prepare("DELETE FROM maintenance WHERE session = ? OR requester = ?").run(lane, lane);
  for (const batch of batches) summarize(db, String(batch["batch"]), String(batch["requester"]));
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
  runtime: string | undefined,
): string[] {
  db.prepare("UPDATE sessions SET maintenance = ?, runtime = ? WHERE id = ?").run(
    Number(supported),
    runtime ?? null,
    session,
  );
  const refused = supported
    ? []
    : db
        .prepare(
          "SELECT id FROM maintenance WHERE session = ? AND state = 'pending' AND kind = 'reload'",
        )
        .all(session);
  const replaced = started
    ? db
        .prepare(
          `SELECT id FROM maintenance WHERE session = ?1 AND state = 'reloading'
           AND (kind = 'stow' OR (?2 IS NOT NULL AND (runtime IS NULL OR runtime != ?2)))`,
        )
        .all(session, runtime ?? null)
    : [];
  return [
    ...refused.flatMap((row) => {
      actor(db, Number(row["id"]), session);
      return settle(db, Number(row["id"]), "failed", UNSUPPORTED);
    }),
    ...replaced.flatMap((row) =>
      settle(db, Number(row["id"]), "completed", "reconnected on a new process"),
    ),
  ];
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
  const open = db
    .prepare(
      "SELECT id, state FROM maintenance WHERE session = ? AND kind = ? AND state IN ('pending', 'reloading')",
    )
    .get(target.id, raw.kind);
  const started = open?.["state"] === "reloading" && raw.kind === "reload";
  if (open !== undefined && !started) {
    attach(db, raw.batch, caller.id, raw.kind, Number(open["id"]));
    return [target.id];
  }
  const { state, detail } = started
    ? { state: "failed" as const, detail: IN_FLIGHT }
    : outcome(target, Date.now(), t);
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO maintenance (batch, requester, session, kind, state, process, runtime, detail, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      raw.batch,
      caller.id,
      target.id,
      raw.kind,
      state,
      target.process,
      raw.kind === "reload" ? target.runtime : null,
      detail,
      Date.now(),
    );
  if (inserted.changes === 0) return [];
  const id = Number(inserted.lastInsertRowid);
  attach(db, raw.batch, caller.id, raw.kind, id);
  return state === "pending" ? [target.id] : [];
}

const known = (db: DatabaseSync, batch: string): boolean =>
  db
    .prepare(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM maintenance WHERE batch = ?1)
         OR EXISTS (SELECT 1 FROM maintenance_batches WHERE batch = ?1)`,
    )
    .get(batch) !== undefined;

export function requestMaintenance(
  db: DatabaseSync,
  caller: Session,
  raw: OpArgs<"maintenance.request">,
  t: Timings,
  scope?: Scope,
): { value: Maintenance[]; notify: string[] } {
  if (caller.lane !== mainLane(db))
    throw new Error("only main can ask the fleet to reload or stow");
  if (raw.kind === "reload" && known(db, raw.batch))
    return { value: projected(db, batchRows(db, raw.batch)), notify: [] };
  const notify = targets(db, caller.id, raw.kind, t.wall(), scope).flatMap((target) =>
    requestTarget(db, caller, raw, target, t),
  );
  return { value: projected(db, batchRows(db, raw.batch)), notify };
}

export function maintenanceStatus(
  db: DatabaseSync,
  caller: Session,
  args: OpArgs<"maintenance.status">,
): { value: Maintenance[]; notify: string[] } {
  if (caller.lane !== mainLane(db))
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
  return { value: projected(db, batchRows(db, args.batch)), notify };
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
      "SELECT kind, state FROM maintenance WHERE id = ? AND session = ? AND state IN ('pending', 'reloading')",
    )
    .get(args.id, caller.id);
  if (open === undefined) return { value: readMaintenance(db, caller, args.id), notify: [] };
  const names =
    open["kind"] === "reload" && (args.state !== "failed" || open["state"] === "pending");
  if (names) actor(db, args.id, caller.id);
  if (args.state === "failed") {
    const notify = settle(db, args.id, "failed", sanitize(args.detail));
    return { value: readMaintenance(db, caller, args.id), notify };
  }
  db.prepare("UPDATE maintenance SET state = ?, detail = ?, updated_at = ? WHERE id = ?").run(
    args.state,
    args.detail,
    Date.now(),
    args.id,
  );
  return { value: readMaintenance(db, caller, args.id), notify: [] };
}

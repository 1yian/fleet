import type { DatabaseSync } from "node:sqlite";
import { stopOf, untilOf } from "./lane-stop.ts";
import type { Timings } from "./timing.ts";

export const UNSUPPORTED =
  "runs code from before safe reloads, so it was left running: restart it by hand";

export interface Target {
  readonly id: string;
  readonly role: "mate" | "worker";
  readonly connected: boolean;
  readonly supported: boolean;
  readonly process: string | null;
  readonly runtime: string | null;
  readonly seen: number;
}

export interface Scope {
  readonly hosts: readonly string[];
}

export function adoptPlacement(db: DatabaseSync, session: string, host: string | undefined): void {
  db.prepare("UPDATE sessions SET placed_host = ? WHERE id = ?").run(host ?? "", session);
}

const inScope = (row: Record<string, unknown>, scope: Scope | undefined): boolean => {
  if (scope === undefined) return true;
  const where = String(row[row["role"] === "mate" ? "placed" : "host"]);
  return where !== "" && scope.hosts.includes(where);
};

export function targets(
  db: DatabaseSync,
  requester: string,
  kind: string,
  now: number,
  scope: Scope | undefined,
): Target[] {
  const rows = db
    .prepare(
      `SELECT s.id AS id, s.role AS role, s.host AS host, s.placed_host AS placed, s.process AS process, s.runtime AS runtime, s.maintenance AS supported, coalesce(s.last_seen, 0) AS seen,
         s.stopping_until AS until, s.state IN ('idle', 'running', 'waiting') AS connected
       FROM sessions s LEFT JOIN attempts a ON a.id = s.attempt
       WHERE s.id != ? AND s.state NOT IN ('starting', 'closed')
         AND (s.role = 'mate' OR a.state = 'active')
         AND (? = 'reload' OR s.role = 'mate')
       ORDER BY s.role DESC, s.id`,
    )
    .all(requester, kind)
    .filter((row) => inScope(row, scope) && stopOf(untilOf(row), now).kind === "up");
  return rows.map((row) => ({
    id: String(row["id"]),
    role: row["role"] === "mate" ? "mate" : "worker",
    connected: row["connected"] === 1,
    supported: row["supported"] === 1,
    process: typeof row["process"] === "string" ? row["process"] : null,
    runtime: typeof row["runtime"] === "string" ? row["runtime"] : null,
    seen: Number(row["seen"]),
  }));
}

export function outcome(
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
  if (!target.supported) return { state: "failed", detail: UNSUPPORTED };
  return {
    state: "pending",
    detail: "waiting for a safe point: its turn and any job finish first",
  };
}

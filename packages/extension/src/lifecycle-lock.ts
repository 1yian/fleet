import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HostUnread } from "./host.ts";
import { remainingMs } from "./maintenance-budget.ts";

const DEFAULT_WAIT_MS = 45_000;
const SQLITE_BUSY = 5;

function waitMs(): number {
  const set = Number(process.env["FLEET_LIFECYCLE_WAIT_MS"]);
  return Number.isInteger(set) && set >= 0 ? set : DEFAULT_WAIT_MS;
}

export async function withLifecycleLock<T>(
  home: string,
  lane: string,
  work: () => Promise<T>,
  deadline?: number,
): Promise<T> {
  const remaining = remainingMs(deadline);
  if (remaining === 0) throw new HostUnread("maintenance deadline reached");
  const timeout = waitMs();
  mkdirSync(join(home, "state"), { recursive: true });
  const db = new DatabaseSync(join(home, "state", "lifecycle.db"), {
    timeout: Math.min(timeout, remaining),
  });
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    if (!(error instanceof Error) || Reflect.get(error, "errcode") !== SQLITE_BUSY) throw error;
    if (remaining <= timeout) throw new HostUnread("maintenance deadline reached");
    throw new Error(
      `another fleet command is starting or stopping lane ${lane}, and did not finish within ${String(timeout)} ms`,
      { cause: error },
    );
  }
  try {
    return await work();
  } finally {
    db.close();
  }
}

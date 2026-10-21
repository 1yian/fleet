import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
): Promise<T> {
  mkdirSync(join(home, "state"), { recursive: true });
  const db = new DatabaseSync(join(home, "state", "lifecycle.db"), { timeout: waitMs() });
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    if (!(error instanceof Error) || Reflect.get(error, "errcode") !== SQLITE_BUSY) throw error;
    throw new Error(
      `another fleet command is starting or stopping lane ${lane}, and did not finish within ${String(waitMs())} ms`,
      { cause: error },
    );
  }
  try {
    return await work();
  } finally {
    db.close();
  }
}

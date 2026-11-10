import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_FILE = "takeover.lock";

export interface LaneLock {
  readonly release: () => void;
}

const failedWith = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

function create(file: string): boolean {
  try {
    writeFileSync(file, `${String(process.pid)}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (failedWith(error, "EEXIST")) return false;
    throw error;
  }
}

function holder(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    if (failedWith(error, "ENOENT")) return undefined;
    throw error;
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return failedWith(error, "EPERM");
  }
}

export function lockLane(folder: string, lane: string): LaneLock {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, LOCK_FILE);
  for (;;) {
    if (create(file))
      return {
        release: () => {
          rmSync(file, { force: true });
        },
      };
    const text = holder(file);
    if (text === undefined) continue;
    const pid = Number(text);
    if (Number.isInteger(pid) && pid > 0 && !running(pid)) {
      rmSync(file, { force: true });
      continue;
    }
    throw new Error(
      `lane ${lane} is already being taken over by process ${text === "" ? "unknown" : text}: finish or discard that takeover first. If no takeover is running, delete ${file}`,
    );
  }
}

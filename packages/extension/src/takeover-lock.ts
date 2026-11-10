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

function recover(file: string, stale: string): boolean {
  const claim = `${file}.${stale}`;
  if (!create(claim)) return false;
  try {
    if (holder(file) === stale) rmSync(file, { force: true });
  } finally {
    rmSync(claim, { force: true });
  }
  return true;
}

function owned(file: string): LaneLock {
  return {
    release: () => {
      if (holder(file) === String(process.pid)) rmSync(file, { force: true });
    },
  };
}

export function lockLane(folder: string, lane: string): LaneLock {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, LOCK_FILE);
  for (;;) {
    if (create(file)) return owned(file);
    const text = holder(file);
    if (text === undefined) continue;
    const pid = Number(text);
    const gone = Number.isInteger(pid) && pid > 0 && !running(pid);
    if (gone && recover(file, text)) continue;
    throw new Error(
      gone
        ? `lane ${lane} is being recovered from a takeover that ended without cleaning up, by another takeover that is starting now: try again. If none is starting, delete ${file}.${text}`
        : `lane ${lane} is already being taken over by process ${text === "" ? "unknown" : text}: finish or discard that takeover first. If no takeover is running, delete ${file}`,
    );
  }
}

import { accessSync, constants, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";

const CANDIDATES = ["/var/tmp", tmpdir()];

export function diskBase(): string {
  for (const dir of CANDIDATES) {
    try {
      accessSync(dir, constants.W_OK);
      return realpathSync(dir);
    } catch {
      continue;
    }
  }
  throw new Error("no writable folder for the end-to-end run");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export function staleFolders(base: string, prefix: string): string[] {
  return readdirSync(base).filter((name) => {
    if (!name.startsWith(prefix)) return false;
    const owner = Number(name.slice(prefix.length).split("-")[0]);
    return Number.isInteger(owner) && owner > 0 && !processAlive(owner);
  });
}

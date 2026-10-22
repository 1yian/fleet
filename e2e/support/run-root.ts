import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "fr-";
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const outerTmpdir = tmpdir();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function sweepStaleRoots(): void {
  for (const name of readdirSync(outerTmpdir)) {
    if (!name.startsWith(PREFIX)) continue;
    const owner = Number(name.slice(PREFIX.length).split("-")[0]);
    if (Number.isInteger(owner) && owner > 0 && !alive(owner)) {
      try {
        rmSync(join(outerTmpdir, name), { recursive: true, force: true });
      } catch {
        continue;
      }
    }
  }
}

function claimRoot(): string {
  sweepStaleRoots();
  const root = mkdtempSync(join(outerTmpdir, `${PREFIX}${String(process.pid)}-`));
  const remove = (): void => {
    rmSync(root, { recursive: true, force: true });
  };
  process.on("exit", remove);
  for (const name of SIGNALS) {
    process.once(name, () => {
      remove();
      process.kill(process.pid, name);
    });
  }
  return root;
}

const runRoot = claimRoot();
process.env["TMPDIR"] = runRoot;
if (process.env["NODE_COMPILE_CACHE"] !== undefined) {
  process.env["NODE_COMPILE_CACHE"] = join(runRoot, "node-compile-cache");
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(runRoot, prefix));
}

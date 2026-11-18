import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { cacheDirectory, runBase, sweepStaleFileFolders } from "./run-folders.ts";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const outerTmpdir = runBase();

const assigned = process.env["FLEET_E2E_ROOT"] || undefined;
Reflect.deleteProperty(process.env, "FLEET_E2E_ROOT");

function claimRoot(): string {
  if (assigned !== undefined) return realpathSync(assigned);
  sweepStaleFileFolders(outerTmpdir);
  const root = mkdtempSync(join(outerTmpdir, `fr-${String(process.pid)}-`));
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
process.env["FLEET_HOST_DIR"] = join(runRoot, "host");
process.env["FLEET_TMP_SOURCE_DIR"] = join(runRoot, "old-tmp");
process.env["XDG_CONFIG_HOME"] = join(runRoot, "xdg");
if (process.env["NODE_COMPILE_CACHE"] !== undefined) {
  process.env["NODE_COMPILE_CACHE"] = join(runRoot, "node-compile-cache");
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(runRoot, prefix));
}

const cacheBase = assigned === undefined ? outerTmpdir : dirname(outerTmpdir);
export const sharedCacheDir = (): string => cacheDirectory(cacheBase);

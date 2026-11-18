import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cacheDirectory, runBase, sweepStaleFolders } from "./run-folders.ts";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const outerTmpdir = runBase();

const assigned = process.env["FLEET_E2E_ROOT"];
Reflect.deleteProperty(process.env, "FLEET_E2E_ROOT");

function claimRoot(): string {
  if (assigned !== undefined && assigned !== "") return realpathSync(assigned);
  sweepStaleFolders(outerTmpdir, "file");
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
const inheritedXdg = process.env["FLEET_E2E_XDG"];
if (inheritedXdg === undefined || process.env["XDG_CONFIG_HOME"] !== inheritedXdg) {
  const xdg = join(runRoot, "xdg");
  process.env["XDG_CONFIG_HOME"] = xdg;
  process.env["FLEET_E2E_XDG"] = xdg;
}
if (process.env["NODE_COMPILE_CACHE"] !== undefined) {
  process.env["NODE_COMPILE_CACHE"] = join(runRoot, "node-compile-cache");
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(runRoot, prefix));
}

export const sharedCacheDir = (): string => cacheDirectory(outerTmpdir);

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { diskBase, staleFolders } from "./run-folders.ts";

const PREFIX = "fr-";
const ROOMY_DISK = new URL("./roomy-disk.ts", import.meta.url).href;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const outerTmpdir = realpathSync(process.env["FLEET_E2E_TMPDIR"] ?? diskBase());

function sweepStaleRoots(): void {
  for (const name of staleFolders(outerTmpdir, PREFIX)) {
    try {
      rmSync(join(outerTmpdir, name), { recursive: true, force: true });
    } catch {
      continue;
    }
  }
}

const assigned = process.env["FLEET_E2E_ROOT"];
Reflect.deleteProperty(process.env, "FLEET_E2E_ROOT");

function claimRoot(): string {
  if (assigned !== undefined && assigned !== "") return assigned;
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
process.env["FLEET_HOST_DIR"] = join(runRoot, "host");
process.env["FLEET_TMP_SOURCE_DIR"] = join(runRoot, "old-tmp");
const inheritedXdg = process.env["FLEET_E2E_XDG"];
if (inheritedXdg === undefined || process.env["XDG_CONFIG_HOME"] !== inheritedXdg) {
  const xdg = join(runRoot, "xdg");
  process.env["XDG_CONFIG_HOME"] = xdg;
  process.env["FLEET_E2E_XDG"] = xdg;
}
if (!(process.env["NODE_OPTIONS"] ?? "").includes(ROOMY_DISK)) {
  process.env["NODE_OPTIONS"] =
    `${process.env["NODE_OPTIONS"] ?? ""} --import=${ROOMY_DISK}`.trim();
}
if (process.env["NODE_COMPILE_CACHE"] !== undefined) {
  process.env["NODE_COMPILE_CACHE"] = join(runRoot, "node-compile-cache");
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(runRoot, prefix));
}

export const sharedCacheDir =
  process.env["FLEET_E2E_CACHE"] ?? join(outerTmpdir, "fleet-e2e-cache");

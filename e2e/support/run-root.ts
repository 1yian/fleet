import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GROUPS_ENV, groupScopes, openGroupScope } from "./marked.ts";
import { guardRoot } from "./reaper-client.ts";
import { runBase } from "./run-folders.ts";

const outerTmpdir = runBase();

export function retainRunRoot(): void {
  writeFileSync(join(runRoot, "unresolved-groups"), "", { mode: 0o600 });
}

const assigned = (process.env["FLEET_E2E_ROOT"] ?? "") || undefined;
Reflect.deleteProperty(process.env, "FLEET_E2E_ROOT");

const runRoot =
  assigned === undefined
    ? mkdtempSync(join(outerTmpdir, `fr-${String(process.pid)}-`))
    : realpathSync(assigned);
process.env["TMPDIR"] = runRoot;
process.env["FLEET_HOST_DIR"] = join(runRoot, "host");
process.env["FLEET_TMP_SOURCE_DIR"] = join(runRoot, "old-tmp");
process.env["XDG_CONFIG_HOME"] = join(runRoot, "xdg");
if (process.env["NODE_COMPILE_CACHE"] !== undefined) {
  process.env["NODE_COMPILE_CACHE"] = join(runRoot, "node-compile-cache");
}

if (assigned === undefined) {
  const directScope = join(runRoot, "groups");
  mkdirSync(directScope, { mode: 0o700 });
  openGroupScope(directScope);
  process.env[GROUPS_ENV] = JSON.stringify([...groupScopes(), directScope]);
  guardRoot(runRoot, directScope);
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(runRoot, prefix));
}

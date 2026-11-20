import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./run-root.ts";

const LIVE_ENVIRONMENT = [
  "FLEET_HOSTS",
  "FLEET_HOST",
  "FLEET_ROOTS",
  "FLEET_ROOT",
  "FLEET_URL",
  "FLEET_TOKEN",
  "FLEET_BWS",
  "FLEET_ROLE",
  "FLEET_PI_ARGS",
  "FLEET_CONFIG_DIR",
  "FLEET_SCRATCH",
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SESSION",
  "HERDR_SOCKET_PATH",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
];

for (const name of LIVE_ENVIRONMENT) Reflect.deleteProperty(process.env, name);

const BASH = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
const PANE_SHELL = join(tempDir("pane-shell-"), "shell");
writeFileSync(
  PANE_SHELL,
  `#!/bin/sh\nexport HISTFILE=/dev/null\nexec '${BASH}' --noprofile --norc "$@"\n`,
  { mode: 0o755 },
);
process.env["SHELL"] = PANE_SHELL;

process.env["FLEET_TAILSCALE"] = "false";
process.env["ELEMENT_HOME"] = tempDir("element-");

const ROOMY_DISK = `--import=${new URL("./roomy-disk.ts", import.meta.url).href}`;
const nodeOptions = process.env["NODE_OPTIONS"] ?? "";
if (!nodeOptions.split(" ").includes(ROOMY_DISK))
  process.env["NODE_OPTIONS"] = `${nodeOptions} ${ROOMY_DISK}`.trim();

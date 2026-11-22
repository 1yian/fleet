import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitFork, initFork, routeFork } from "./fork-fixture.ts";
import { tempDir } from "./run-root.ts";
import { seedTiers } from "./tiers-fixture.ts";

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
  "PI_TIERS_CONFIG",
  "NM_HOME",
  "GIT_CONFIG_COUNT",
  "FAKE_PI_LOG",
  "FAKE_PI_SELF_UPDATE_REFUSAL",
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
process.env["PI_CODING_AGENT_DIR"] = tempDir("agent-");
seedTiers(process.env["PI_CODING_AGENT_DIR"]);

const ROOMY_DISK = `--import=${new URL("./roomy-disk.ts", import.meta.url).href}`;
const nodeOptions = process.env["NODE_OPTIONS"] ?? "";
if (!nodeOptions.split(" ").includes(ROOMY_DISK))
  process.env["NODE_OPTIONS"] = `${nodeOptions} ${ROOMY_DISK}`.trim();

const FORK = join(tempDir("fork-"), "no-mistakes");
mkdirSync(FORK);
initFork(FORK);
process.env["FAKE_NO_MISTAKES_COMMIT"] = commitFork(FORK, "2026-11-19T08:47:26-06:00");
Object.assign(process.env, routeFork(FORK));
const PI_STATE = join(tempDir("pi-state-"), "packages");
writeFileSync(PI_STATE, "git:github.com/1yian/pi-tiers\n");
process.env["FAKE_PI_STATE"] = PI_STATE;

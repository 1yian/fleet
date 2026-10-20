// Starts fleet mates. Each lane's settings are in <config>/<lane>.json, where
// <config> is FLEET_CONFIG_DIR or ~/.config/fleet:
//   { "url": "ws://<cardd>/session", "token": "...", "home": "/path/to/the/lane/home",
//     "args": ["--model", "tier/default"], "hosts": { "p620": ["ssh", "p620"] },
//     "workerArgs": ["--model", "tier/quick"] }
// Usage:
//   fleet <lane> [pi arguments]  runs the lane's mate in this terminal, in the lane's home.
//                                It continues the mate's conversation, so a restart keeps it.
//   fleet up                     starts every lane configured on this host whose mate does not
//                                run, each in its own herdr workspace, fleet-<lane>.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { field, herdr as herdrOn, piRunning, records, rootPane } from "./host.ts";

const EXTENSION = fileURLToPath(new URL("./index.ts", import.meta.url));
const CALM = fileURLToPath(new URL("./calm/index.ts", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const CONFIG = process.env["FLEET_CONFIG_DIR"] ?? join(homedir(), ".config", "fleet");

interface Lane {
  readonly name: string;
  readonly url: string;
  readonly token: string;
  readonly home: string;
  readonly args: readonly string[];
  readonly hosts: Record<string, unknown>;
  readonly workerArgs: readonly string[];
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each) => typeof each === "string") : [];
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

function readLane(name: string): Lane {
  const file = join(CONFIG, `${name}.json`);
  const config: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(config)) throw new Error(`${file} is not a JSON object`);
  const { url, token, home } = config;
  if (typeof url !== "string" || typeof token !== "string" || typeof home !== "string") {
    throw new Error(`${file} needs "url", "token", and "home"`);
  }
  const hosts = isRecord(config["hosts"]) ? config["hosts"] : {};
  const args = strings(config["args"]);
  return { name, url, token, home, args, hosts, workerArgs: strings(config["workerArgs"]) };
}

/** Runs the lane's mate in this terminal until it exits. */
function runMate(lane: Lane, extra: readonly string[]): number {
  const fleet = ["--fleet-url", lane.url, "--fleet-token", lane.token, "--fleet-role", "mate"];
  // Mates also get /calm (docs/calm.md). Workers do not.
  const args = ["-e", EXTENSION, "-e", CALM, ...fleet, "--continue", ...lane.args, ...extra];
  const env = {
    ...process.env,
    // Calm keeps its choice in <home>/config/calm.
    FLEET_HOME: lane.home,
    // Workers get the extension the same way, plus their own Pi arguments.
    FLEET_PI_ARGS: JSON.stringify(["-e", EXTENSION, ...lane.workerArgs]),
    FLEET_HOSTS: JSON.stringify(lane.hosts),
  };
  return spawnSync("pi", args, { stdio: "inherit", env, cwd: lane.home }).status ?? 1;
}

// Mates start on this host: the one that `fleet up` runs on.
const herdr = (args: readonly string[]): Promise<Json> => herdrOn("local", args);

/** The pane that holds the lane's mate: the root pane of its workspace, created if needed. */
async function matePane(
  lane: Lane,
  workspaces: readonly Json[],
): Promise<{ pane: string; found: boolean }> {
  const label = `fleet-${lane.name}`;
  const workspace = field(
    workspaces.find((each) => each["label"] === label),
    "workspace_id",
  );
  if (workspace === undefined) {
    const args = ["workspace", "create", "--cwd", lane.home, "--label", label, "--no-focus"];
    return { pane: rootPane(await herdr(args)), found: false };
  }
  const pane = field(
    records((await herdr(["pane", "list", "--workspace", workspace]))["panes"])[0],
    "pane_id",
  );
  if (pane === undefined) throw new Error(`workspace ${label} has no pane`);
  return { pane, found: true };
}

async function up(): Promise<void> {
  const workspaces = records((await herdr(["workspace", "list"]))["workspaces"]);
  const lanes = readdirSync(CONFIG).filter((file) => file.endsWith(".json"));
  for (const lane of lanes.sort().map((file) => readLane(file.slice(0, -".json".length)))) {
    const { pane, found } = await matePane(lane, workspaces);
    if (found && (await piRunning("local", pane))) {
      console.log(`${lane.name}: already running in fleet-${lane.name}`);
      continue;
    }
    const start = [process.execPath, SELF, lane.name].map(quote).join(" ");
    await herdr(["pane", "run", pane, `FLEET_CONFIG_DIR=${quote(CONFIG)} ${start}`]);
    console.log(`${lane.name}: started in fleet-${lane.name}`);
  }
}

const [command, ...extra] = process.argv.slice(2);
if (command === undefined || command === "")
  throw new Error("usage: fleet <lane> [pi arguments] | fleet up");
if (command === "up") await up();
else process.exit(runMate(readLane(command), extra));

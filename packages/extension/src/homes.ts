// Lane homes on this host, and the mates that run in them (docs/setup.md).
// Main's home is the fleet repo itself. Each second mate's home is a git worktree of it,
// <root>.worktrees/lane-<lane>, with its own private config/, data/, and state/. A mate runs
// as plain `pi` in its home, in its own herdr workspace, fleet-<lane>. A lane is:
//   running  its mate is in the pane.
//   down     it should run and does not: `up` starts it.
//   stopped  held on purpose, by hand or because it kept crashing: only `up <lane>` starts it.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { field, herdr as herdrOn, piRunning, quote, records } from "./host.ts";
import { isRecord, LANE_FILE, readLaneConfig, type LaneConfig } from "./lane-config.ts";

interface LaneHome {
  readonly lane: string;
  readonly home: string;
  readonly config: LaneConfig;
}
export interface Status {
  readonly lane: string;
  readonly state: "running" | "down" | "stopped";
  readonly reason?: string;
}
export interface Outcome {
  readonly lane: string;
  readonly action: "started" | "running" | "held" | "stopped";
  readonly detail?: string;
}

/** A lane that starts this many times within the window is held instead of started again. */
const CRASH_STARTS = 3;
const CRASH_WINDOW_MS = 10 * 60_000;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** The main checkout of this repository: the code root, even when this file runs from a lane's worktree. */
export function codeRoot(): string {
  const set = process.env["FLEET_ROOT"];
  if (set !== undefined && set !== "") return set;
  const here = dirname(fileURLToPath(import.meta.url));
  return dirname(git(here, "rev-parse", "--path-format=absolute", "--git-common-dir"));
}

export const homeOf = (root: string, lane: string): string =>
  join(`${root}.worktrees`, `lane-${lane}`);

/** The home of a lane on this host: the root for main, a worktree of it for any other lane. */
export function existingHome(root: string, lane: string): string {
  if (readLaneConfig(root)?.lane === lane) return root;
  const home = homeOf(root, lane);
  if (readLaneConfig(home)?.lane !== lane) throw new Error(`no lane ${lane} on this host`);
  return home;
}

/** The lane homes of this host: worktrees of the root that hold a config/lane.json. */
function laneHomes(root: string): LaneHome[] {
  const dir = `${root}.worktrees`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("lane-"))
    .sort()
    .flatMap((name) => {
      const home = join(dir, name);
      const config = readLaneConfig(home);
      return config === undefined ? [] : [{ lane: config.lane, home, config }];
    });
}

/** Creates a second mate's home: a worktree of the root at its commit, with the lane's settings. */
export function provision(root: string, config: LaneConfig): string {
  const home = homeOf(root, config.lane);
  if (existsSync(home)) throw new Error(`${home} already exists`);
  git(root, "worktree", "add", "--detach", home, "HEAD");
  // The worktree shares the root's installed packages, so it needs no install of its own.
  if (existsSync(join(root, "node_modules")))
    symlinkSync(join(root, "node_modules"), join(home, "node_modules"));
  writeLaneConfig(home, config);
  mkdirSync(join(home, "data"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
}

export function writeLaneConfig(home: string, config: LaneConfig): void {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, LANE_FILE), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// Mates start on this host: the one that `fleet` runs on.
const herdr = (args: readonly string[]): Promise<Record<string, unknown>> => herdrOn("local", args);

const stoppedFile = (home: string): string => join(home, "state", "stopped");
const startsFile = (home: string): string => join(home, "state", "starts");

function heldReason(home: string): string | undefined {
  try {
    return readFileSync(stoppedFile(home), "utf8").trim() || "stopped";
  } catch {
    return undefined;
  }
}

async function workspaceOf(lane: string): Promise<string | undefined> {
  const listed = records((await herdr(["workspace", "list"]))["workspaces"]);
  return field(
    listed.find((each) => each["label"] === `fleet-${lane}`),
    "workspace_id",
  );
}

async function panesOf(workspace: string): Promise<string | undefined> {
  const listed = records((await herdr(["pane", "list", "--workspace", workspace]))["panes"]);
  return field(listed[0], "pane_id");
}

async function running(lane: string): Promise<boolean> {
  const workspace = await workspaceOf(lane);
  if (workspace === undefined) return false;
  const pane = await panesOf(workspace);
  return pane !== undefined && (await piRunning("local", pane));
}

export async function status(root: string): Promise<Status[]> {
  const out: Status[] = [];
  for (const { lane, home } of laneHomes(root)) {
    const reason = heldReason(home);
    if (await running(lane)) out.push({ lane, state: "running" });
    else
      out.push(reason === undefined ? { lane, state: "down" } : { lane, state: "stopped", reason });
  }
  return out;
}

/** Moves a clean home to the commit that the root has, so a mate starts on the code that its host runs. */
function syncHome(root: string, home: string): void {
  const target = git(root, "rev-parse", "HEAD");
  if (git(home, "rev-parse", "HEAD") === target || git(home, "status", "--porcelain") !== "")
    return;
  git(home, "checkout", "--detach", target);
}

function recentStarts(home: string, now: number): number[] {
  try {
    const times = readFileSync(startsFile(home), "utf8").split("\n").map(Number);
    return times.filter((time) => time > now - CRASH_WINDOW_MS);
  } catch {
    return [];
  }
}

const SHELL_WAIT_MS = 20_000;

/**
 * Waits until the shell has run the command: Pi shows in the pane. Until then the pane looks idle, and
 * a second `up` would type the command again. A Pi that dies at once may never be seen, so the wait is bounded.
 */
async function seen(pane: string): Promise<void> {
  const deadline = Date.now() + SHELL_WAIT_MS;
  while (Date.now() < deadline && !(await piRunning("local", pane))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function start(root: string, info: LaneHome): Promise<void> {
  syncHome(root, info.home);
  const workspace = await workspaceOf(info.lane);
  let pane: string | undefined;
  if (workspace === undefined) {
    const args = [
      "workspace",
      "create",
      "--cwd",
      info.home,
      "--label",
      `fleet-${info.lane}`,
      "--no-focus",
    ];
    const created = await herdr(args);
    pane = field(isRecord(created["root_pane"]) ? created["root_pane"] : undefined, "pane_id");
  } else pane = await panesOf(workspace);
  if (pane === undefined) throw new Error(`workspace fleet-${info.lane} has no pane`);
  // --continue picks the mate's conversation up again, so a restart keeps it.
  const pi = ["pi", "--continue", ...info.config.args];
  // direnv exec loads the folder's .envrc and then replaces itself with Pi, so the pane runs Pi.
  const { direnv } = info.config;
  const command = direnv === undefined ? pi : ["direnv", "exec", direnv, ...pi];
  await herdr(["pane", "run", pane, `cd ${quote(info.home)} && ${command.map(quote).join(" ")}`]);
  await seen(pane);
  mkdirSync(join(info.home, "state"), { recursive: true });
  const starts = [...recentStarts(info.home, Date.now()), Date.now()];
  writeFileSync(startsFile(info.home), `${starts.join("\n")}\n`);
}

const named = (root: string, lane: string | undefined): LaneHome[] => {
  const all = laneHomes(root);
  const found = lane === undefined ? all : all.filter((each) => each.lane === lane);
  if (lane !== undefined && found.length === 0) throw new Error(`no lane ${lane} on this host`);
  return found;
};

/**
 * Starts every lane whose mate does not run. A lane that is held stays held, and so does one that
 * already started CRASH_STARTS times in the window. Naming a lane starts it whatever its state.
 */
export async function up(root: string, only?: string): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const info of named(root, only)) {
    const { lane, home } = info;
    // Naming a held lane lifts the hold and forgets its crashes.
    if (only !== undefined && heldReason(home) !== undefined) {
      rmSync(stoppedFile(home), { force: true });
      rmSync(startsFile(home), { force: true });
    }
    const reason = heldReason(home);
    if (reason !== undefined) out.push({ lane, action: "stopped", detail: reason });
    else if (await running(lane)) out.push({ lane, action: "running" });
    else if (recentStarts(home, Date.now()).length >= CRASH_STARTS) {
      const detail = `started ${String(CRASH_STARTS)} times in ${String(CRASH_WINDOW_MS / 60_000)} minutes`;
      writeFileSync(stoppedFile(home), `crash loop: ${detail}\n`);
      out.push({ lane, action: "held", detail });
    } else {
      await start(root, info);
      out.push({ lane, action: "started" });
    }
  }
  return out;
}

async function close(lane: string): Promise<void> {
  const workspace = await workspaceOf(lane);
  if (workspace !== undefined) await herdr(["workspace", "close", workspace]);
}

/** Closes the lane's workspace and holds the lane, so `up` leaves it alone. Its conversation stays. */
export async function stop(root: string, lane: string): Promise<void> {
  for (const info of named(root, lane)) {
    mkdirSync(join(info.home, "state"), { recursive: true });
    writeFileSync(stoppedFile(info.home), "stopped by hand\n");
    await close(info.lane);
  }
}

/** Stops the mate and starts it again on its own conversation, for one lane or for every lane (no name). */
export async function restart(root: string, lane: string | undefined): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const info of named(root, lane)) {
    // Restarting every lane leaves alone a lane that was held on purpose.
    const held = heldReason(info.home);
    if (lane === undefined && held !== undefined) {
      out.push({ lane: info.lane, action: "stopped", detail: held });
      continue;
    }
    await close(info.lane);
    rmSync(stoppedFile(info.home), { force: true });
    rmSync(startsFile(info.home), { force: true });
    await start(root, info);
    out.push({ lane: info.lane, action: "started" });
  }
  return out;
}

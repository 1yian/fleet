import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quote } from "@fleet/protocol/route";
import { arrangeHere, claimFollowers } from "./arrange.ts";
import { TRUST_ARG } from "./fleet-args.ts";
import { field, herdr as herdrOn, paneMissing, piRunning, records, shellIdle } from "./host.ts";
import { withLifecycleLock } from "./lifecycle-lock.ts";
import {
  isRecord,
  LANE_FILE,
  mateStartArgs,
  parseLaneConfig,
  readLaneConfig,
  type LaneConfig,
} from "./lane-config.ts";
import { withCompileCache } from "./scratch.ts";
import { isWorkerWorkspace, legacyMatePrefix, mateTitle, workspaceRootPane } from "./titles.ts";

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

const STARTS_BEFORE_HOLD = 3;
const CRASH_WINDOW_MS = 10 * 60_000;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export function codeRoot(): string {
  const set = process.env["FLEET_ROOT"];
  if (set !== undefined && set !== "") return set;
  const here = dirname(fileURLToPath(import.meta.url));
  return dirname(git(here, "rev-parse", "--path-format=absolute", "--git-common-dir"));
}

export const homeOf = (root: string, lane: string): string =>
  join(`${root}.worktrees`, `lane-${lane}`);

export function existingHome(root: string, lane: string): string {
  if (readLaneConfig(root)?.lane === lane) return root;
  const home = homeOf(root, lane);
  if (readLaneConfig(home)?.lane !== lane) throw new Error(`no lane ${lane} on this host`);
  return home;
}

export function laneHomes(root: string): LaneHome[] {
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

const stoppedFile = (home: string): string => join(home, "state", "stopped");
const HELD_AT_CREATION = "held since the home was made\n";
const startsFile = (home: string): string => join(home, "state", "starts");

function liftHold(home: string): void {
  rmSync(stoppedFile(home), { force: true });
  rmSync(startsFile(home), { force: true });
}

const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

function isWorktreeOf(root: string, home: string): boolean {
  const here = canonical(home);
  return git(root, "worktree", "list", "--porcelain")
    .split("\n")
    .some((line) => line.startsWith("worktree ") && canonical(line.slice(9)) === here);
}

export function provision(root: string, config: LaneConfig, hold = false): string {
  const home = homeOf(root, config.lane);
  if (!existsSync(home)) git(root, "worktree", "add", "--detach", home, "HEAD");
  else if (!isWorktreeOf(root, home))
    throw new Error(`${home} exists and is not a worktree of ${root}`);
  const modules = join(root, "node_modules");
  if (existsSync(modules) && !existsSync(join(home, "node_modules")))
    symlinkSync(modules, join(home, "node_modules"));
  mkdirSync(join(home, "data"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  if (hold) writeFileSync(stoppedFile(home), HELD_AT_CREATION);
  writeLaneConfig(home, config);
  return home;
}

function replaceFile(file: string, text: string): void {
  const next = `${file}.next`;
  writeFileSync(next, text, { mode: 0o600 });
  renameSync(next, file);
}

export function writeLaneConfig(home: string, config: LaneConfig): void {
  mkdirSync(join(home, "config"), { recursive: true });
  replaceFile(join(home, LANE_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

export function reconfigure(
  home: string,
  changes: {
    readonly args?: readonly string[];
    readonly workerArgs?: readonly string[];
    readonly hosts?: Readonly<Record<string, unknown>>;
    readonly roots?: Readonly<Record<string, unknown>>;
  },
): void {
  const file = join(home, LANE_FILE);
  const current: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(current)) throw new Error(`${file} is not a JSON object`);
  const next = { ...current, ...changes };
  parseLaneConfig(file, next);
  replaceFile(file, `${JSON.stringify(next, null, 2)}\n`);
}

const herdr = (args: readonly string[]): Promise<Record<string, unknown>> => herdrOn("local", args);

function heldReason(home: string): string | undefined {
  try {
    return readFileSync(stoppedFile(home), "utf8").trim() || "stopped";
  } catch {
    return undefined;
  }
}

function paneIsHome(pane: Record<string, unknown> | undefined, home: string): boolean {
  const cwd = field(pane, "cwd");
  return cwd !== undefined && canonical(cwd) === canonical(home);
}

async function candidateMatches(
  workspace: string,
  home: string,
  placement: boolean,
): Promise<boolean> {
  const root = await workspaceRootPane(workspace);
  if (!paneIsHome(root, home)) return false;
  const pane = field(root, "pane_id");
  return !placement || (pane !== undefined && (await piRunning("local", pane)));
}

async function workspaceOf(
  { lane, home }: LaneHome,
  placement = false,
): Promise<string | undefined> {
  const listed = records((await herdr(["workspace", "list"]))["workspaces"]);
  for (const row of listed) {
    const workspace = field(row, "workspace_id");
    if (workspace === undefined) continue;
    const current = row["label"] === mateTitle(lane);
    const legacy = row["label"] === `${legacyMatePrefix}${lane}` && !isWorkerWorkspace(row);
    if (current && !placement) return workspace;
    if (!current && !legacy) continue;
    if (await candidateMatches(workspace, home, placement)) return workspace;
  }
  return undefined;
}

async function running(info: LaneHome): Promise<boolean> {
  const workspace = await workspaceOf(info);
  if (workspace === undefined) return false;
  const pane = field(await workspaceRootPane(workspace), "pane_id");
  if (pane === undefined) return false;
  const alive = (await piRunning("local", pane)) || !(await shellIdle("local", pane));
  return alive && !(await paneMissing("local", pane));
}

export async function status(root: string): Promise<Status[]> {
  const out: Status[] = [];
  for (const info of laneHomes(root)) {
    const { lane, home } = info;
    const reason = heldReason(home);
    if (await running(info)) out.push({ lane, state: "running" });
    else
      out.push(reason === undefined ? { lane, state: "down" } : { lane, state: "stopped", reason });
  }
  return out;
}

export async function placementStatus(
  root: string,
): Promise<{ lane: string; mate: boolean; host?: string }[]> {
  const out: { lane: string; mate: boolean; host?: string }[] = [];
  for (const info of laneHomes(root)) {
    const mate = (await workspaceOf(info, true)) !== undefined;
    out.push({
      lane: info.lane,
      mate,
      ...(info.config.host === undefined ? {} : { host: info.config.host }),
    });
  }
  return out;
}

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

async function untilPiShows(pane: string): Promise<void> {
  const deadline = Date.now() + SHELL_WAIT_MS;
  while (Date.now() < deadline && !(await piRunning("local", pane))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function start(root: string, info: LaneHome): Promise<void> {
  syncHome(root, info.home);
  const workspace = await workspaceOf(info);
  let pane: string | undefined;
  if (workspace === undefined) {
    const args = [
      "workspace",
      "create",
      "--cwd",
      info.home,
      "--label",
      mateTitle(info.lane),
      "--no-focus",
    ];
    const created = await herdr(args);
    pane = field(isRecord(created["root_pane"]) ? created["root_pane"] : undefined, "pane_id");
  } else pane = field(await workspaceRootPane(workspace), "pane_id");
  if (pane === undefined) throw new Error(`workspace ${mateTitle(info.lane)} has no pane`);
  const pi = ["pi", "--continue", TRUST_ARG, ...mateStartArgs(info.config.args, info.config.tier)];
  const { direnv } = info.config;
  const command = withCompileCache(direnv === undefined ? pi : ["direnv", "exec", direnv, ...pi]);
  await herdr(["pane", "run", pane, `cd ${quote(info.home)} && ${command.map(quote).join(" ")}`]);
  await untilPiShows(pane);
  mkdirSync(join(info.home, "state"), { recursive: true });
  const starts = [...recentStarts(info.home, Date.now()), Date.now()];
  writeFileSync(startsFile(info.home), `${starts.join("\n")}\n`);
  await arrangeHere(info.config.host ?? process.env["FLEET_HOST"] ?? "local").catch(
    () => undefined,
  );
}

const named = (root: string, lane: string | undefined): LaneHome[] => {
  const all = laneHomes(root);
  const found = lane === undefined ? all : all.filter((each) => each.lane === lane);
  if (lane !== undefined && found.length === 0) throw new Error(`no lane ${lane} on this host`);
  return found;
};

async function upOne(root: string, info: LaneHome, only: string | undefined): Promise<Outcome> {
  const { lane, home } = info;
  if (only !== undefined && heldReason(home) !== undefined) liftHold(home);
  if (await running(info)) {
    if (heldReason(home) !== undefined) liftHold(home);
    return { lane, action: "running" };
  }
  const reason = heldReason(home);
  if (reason !== undefined) return { lane, action: "stopped", detail: reason };
  if (recentStarts(home, Date.now()).length >= STARTS_BEFORE_HOLD) {
    const detail = `started ${String(STARTS_BEFORE_HOLD)} times in ${String(CRASH_WINDOW_MS / 60_000)} minutes`;
    writeFileSync(stoppedFile(home), `crash loop: ${detail}\n`);
    return { lane, action: "held", detail };
  }
  await start(root, info);
  return { lane, action: "started" };
}

export async function up(root: string, only?: string): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const info of named(root, only))
    out.push(await withLifecycleLock(info.home, info.lane, () => upOne(root, info, only)));
  return out;
}

async function close(info: LaneHome): Promise<void> {
  const workspace = await workspaceOf(info);
  if (workspace === undefined) return;
  await claimFollowers(info.lane, workspace).catch(() => undefined);
  await herdr(["workspace", "close", workspace]);
}

export async function stop(root: string, lane: string): Promise<void> {
  for (const info of named(root, lane)) {
    await withLifecycleLock(info.home, info.lane, async () => {
      mkdirSync(join(info.home, "state"), { recursive: true });
      writeFileSync(stoppedFile(info.home), "stopped by hand\n");
      await close(info);
    });
  }
}

async function restartOne(root: string, info: LaneHome, all: boolean): Promise<Outcome> {
  const held = heldReason(info.home);
  if (all && held !== undefined && !(await running(info)))
    return { lane: info.lane, action: "stopped", detail: held };
  await close(info);
  liftHold(info.home);
  await start(root, info);
  return { lane: info.lane, action: "started" };
}

export async function restart(root: string, lane: string | undefined): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const info of named(root, lane))
    out.push(
      await withLifecycleLock(info.home, info.lane, () =>
        restartOne(root, info, lane === undefined),
      ),
    );
  return out;
}

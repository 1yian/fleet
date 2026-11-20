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
import { field, HostUnread, laneHerdr, lanePaneState, records } from "./host.ts";
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
import { isWorkerWorkspace, legacyMatePrefix, mateTitle } from "./titles.ts";

interface LaneHome {
  readonly lane: string;
  readonly home: string;
  readonly config: LaneConfig;
}
export interface Status {
  readonly lane: string;
  readonly state: "running" | "down" | "stopped" | "unknown";
  readonly reason?: string;
}
export interface Outcome {
  readonly lane: string;
  readonly action: "started" | "running" | "held" | "stopped" | "unread";
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

async function observeList(noun: string, args: readonly string[], keys: readonly string[]) {
  const result = await laneHerdr([noun, "list", ...args], "observe");
  const list = result[`${noun}s`];
  const rows = records(list);
  if (
    !Array.isArray(list) ||
    rows.length !== list.length ||
    rows.some((row) => keys.some((key) => typeof row[key] !== "string" || row[key] === ""))
  )
    throw new HostUnread(`herdr returned an incomplete ${noun} list`);
  return rows;
}

async function rootOfWorkspace(workspace: string) {
  const [root] = await observeList("pane", ["--workspace", workspace], []);
  const pane = field(root, "pane_id");
  if (pane === undefined || pane === "")
    throw new HostUnread(`herdr returned no root pane for ${workspace}`);
  return { pane, cwd: field(root, "cwd") };
}

const ifUnread =
  <T>(fallback: T) =>
  (error: unknown): T => {
    if (error instanceof HostUnread) return fallback;
    throw error;
  };

function heldReason(home: string): string | undefined {
  try {
    return readFileSync(stoppedFile(home), "utf8").trim() || "stopped";
  } catch {
    return undefined;
  }
}

async function candidateMatches(
  workspace: string,
  home: string,
  placement: boolean,
): Promise<boolean> {
  const { pane, cwd } = await rootOfWorkspace(workspace);
  if (cwd === undefined || cwd === "")
    throw new HostUnread(`herdr returned no root pane cwd for ${workspace}`);
  if (canonical(cwd) !== canonical(home)) return false;
  return !placement || (await lanePaneState(pane)) === "pi";
}

async function workspaceOf(
  { lane, home }: LaneHome,
  placement = false,
): Promise<string | undefined> {
  for (const row of await observeList("workspace", [], ["workspace_id", "label"])) {
    const workspace = String(row["workspace_id"]);
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
  const { pane } = await rootOfWorkspace(workspace);
  return (await lanePaneState(pane)) !== "down";
}

async function statusOf(info: LaneHome): Promise<Status> {
  const { lane, home } = info;
  try {
    if (await running(info)) return { lane, state: "running" };
    const reason = heldReason(home);
    return reason === undefined ? { lane, state: "down" } : { lane, state: "stopped", reason };
  } catch (error) {
    if (error instanceof HostUnread) return { lane, state: "unknown", reason: error.message };
    throw error;
  }
}

export async function status(root: string): Promise<Status[]> {
  const out: Status[] = [];
  for (const info of laneHomes(root)) out.push(await statusOf(info));
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
  while (
    Date.now() < deadline &&
    (await lanePaneState(pane).catch(ifUnread("unread" as const))) !== "pi"
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function createMatePane(info: LaneHome): Promise<string> {
  const title = mateTitle(info.lane);
  const created = await laneHerdr(
    ["workspace", "create", "--cwd", info.home, "--label", title, "--no-focus"],
    "mutate",
  );
  const root = created["root_pane"];
  const pane = field(isRecord(root) ? root : undefined, "pane_id");
  if (pane === undefined || pane === "") throw new Error(`workspace ${title} has no pane`);
  return pane;
}

async function start(root: string, info: LaneHome, lift = false): Promise<void> {
  const workspace = await workspaceOf(info);
  const existing = workspace === undefined ? undefined : await rootOfWorkspace(workspace);
  syncHome(root, info.home);
  const pane = existing?.pane ?? (await createMatePane(info));
  const pi = ["pi", "--continue", TRUST_ARG, ...mateStartArgs(info.config.args, info.config.tier)];
  const { direnv } = info.config;
  const command = withCompileCache(direnv === undefined ? pi : ["direnv", "exec", direnv, ...pi]);
  await laneHerdr(
    ["pane", "run", pane, `cd ${quote(info.home)} && ${command.map(quote).join(" ")}`],
    "mutate",
  );
  if (lift) liftHold(info.home);
  mkdirSync(join(info.home, "state"), { recursive: true });
  const starts = [...recentStarts(info.home, Date.now()), Date.now()];
  writeFileSync(startsFile(info.home), `${starts.join("\n")}\n`);
  await untilPiShows(pane);
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
  const alive = await running(info);
  const reason = heldReason(home);
  if (alive) {
    if (reason !== undefined) liftHold(home);
    return { lane, action: "running" };
  }
  const lift = only !== undefined && reason !== undefined;
  if (reason !== undefined && !lift) return { lane, action: "stopped", detail: reason };
  if (!lift && recentStarts(home, Date.now()).length >= STARTS_BEFORE_HOLD) {
    const detail = `started ${String(STARTS_BEFORE_HOLD)} times in ${String(CRASH_WINDOW_MS / 60_000)} minutes`;
    writeFileSync(stoppedFile(home), `crash loop: ${detail}\n`);
    return { lane, action: "held", detail };
  }
  await start(root, info, lift);
  return { lane, action: "started" };
}

export async function up(
  root: string,
  only: string | undefined,
  maintenance: boolean,
): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const info of named(root, only)) {
    const work = withLifecycleLock(info.home, info.lane, () => upOne(root, info, only));
    const unread: Outcome = { lane: info.lane, action: "unread" };
    out.push(await (maintenance ? work.catch(ifUnread(unread)) : work));
  }
  return out;
}

async function close(info: LaneHome): Promise<void> {
  const workspace = await workspaceOf(info);
  if (workspace === undefined) return;
  await claimFollowers(info.lane, workspace).catch(() => undefined);
  const closed = await laneHerdr(["workspace", "close", workspace], "mutate");
  if (closed["type"] !== "ok") throw new Error("herdr did not acknowledge workspace close");
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
  await start(root, info, true);
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

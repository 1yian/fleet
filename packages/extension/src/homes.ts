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
import { field, HostUnread, laneHerdr, lanePaneState, onHost, records } from "./host.ts";
import { withLifecycleLock } from "./lifecycle-lock.ts";
import {
  isRecord,
  LANE_FILE,
  mateStartArgs,
  parseLaneConfig,
  readLaneConfig,
  type LaneConfig,
} from "./lane-config.ts";
import { remainingMs } from "./maintenance-budget.ts";
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

interface SweepResult {
  readonly outcomes: Outcome[];
  readonly failed?: string;
}

const STARTS_BEFORE_HOLD = 3;
const CRASH_WINDOW_MS = 10 * 60_000;

function gitWithin(cwd: string, args: readonly string[], deadline?: number): string {
  const timeout = remainingMs(deadline);
  if (timeout === 0) throw new HostUnread("maintenance deadline reached");
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(deadline === undefined ? {} : { timeout, killSignal: "SIGKILL" }),
    }).trim();
  } catch (error) {
    if (deadline !== undefined && Reflect.get(Object(error), "code") === "ETIMEDOUT")
      throw new HostUnread("maintenance deadline reached");
    throw error;
  }
}

const git = (cwd: string, ...args: string[]): string => gitWithin(cwd, args);

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

async function observeList(
  noun: string,
  args: readonly string[],
  keys: readonly string[],
  deadline?: number,
) {
  const result = await laneHerdr([noun, "list", ...args], "observe", deadline);
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

async function panesOf(workspace: string, count: unknown, deadline?: number) {
  const rows = await observeList("pane", ["--workspace", workspace], ["pane_id"], deadline);
  const panes = rows.map((row) => ({ pane: String(row["pane_id"]), cwd: field(row, "cwd") }));
  if (
    panes.length === 0 ||
    panes.length !== count ||
    new Set(panes.map(({ pane }) => pane)).size !== panes.length ||
    rows.some((row) => row["workspace_id"] !== workspace)
  )
    throw new HostUnread(`herdr returned an incomplete pane list for ${workspace}`);
  return panes;
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

type LaneMatch =
  | { workspace: string; state: "matched" | "running" }
  | { workspace: string; state: "idle"; pane: string };

async function findWorkspace(
  { lane, home }: LaneHome,
  purpose: "liveness" | "placement" | "close" | "restart-held",
  deadline?: number,
): Promise<LaneMatch | undefined> {
  const matchesHome = (cwd: string | undefined) =>
    cwd !== undefined && cwd !== "" && canonical(cwd) === canonical(home);
  for (const row of await observeList("workspace", [], ["workspace_id", "label"], deadline)) {
    const workspace = String(row["workspace_id"]);
    const current = row["label"] === mateTitle(lane);
    const legacy = row["label"] === `${legacyMatePrefix}${lane}` && !isWorkerWorkspace(row);
    if (!current && !legacy) continue;
    if (current && purpose === "close") return { workspace, state: "matched" };
    const panes = await panesOf(workspace, row["pane_count"], deadline);
    const [first] = panes;
    if (first === undefined) throw new HostUnread(`herdr returned no pane for ${workspace}`);
    if (purpose === "close" || purpose === "restart-held") {
      if (legacy && !matchesHome(requiredCwd(first.cwd, workspace))) continue;
      if (purpose === "close") return { workspace, state: "matched" };
      return (await lanePaneState(first.pane, deadline)) !== "down"
        ? { workspace, state: "running" }
        : undefined;
    }
    if (panes.length !== 1) {
      if (purpose === "placement")
        throw new HostUnread(`cannot verify the root pane for split workspace ${workspace}`);
      for (const { pane, cwd } of panes) {
        if (matchesHome(cwd) && (await lanePaneState(pane, deadline)) === "pi")
          return { workspace, state: "running" };
      }
      throw new HostUnread(`no Pi observed in the lane home for split workspace ${workspace}`);
    }
    if ((legacy || purpose === "placement") && !matchesHome(requiredCwd(first.cwd, workspace)))
      continue;
    const state = await lanePaneState(first.pane, deadline);
    if (purpose === "placement" && state !== "pi") continue;
    if (state !== "down") return { workspace, state: "running" };
    return { workspace, state: "idle", pane: first.pane };
  }
  return undefined;
}

function requiredCwd(cwd: string | undefined, workspace: string): string {
  if (cwd === undefined || cwd === "")
    throw new HostUnread(`herdr returned no root pane cwd for ${workspace}`);
  return cwd;
}

async function workspaceOf(
  info: LaneHome,
  purpose: Parameters<typeof findWorkspace>[1],
  deadline?: number,
): Promise<LaneMatch | undefined> {
  return (await findWorkspace(info, purpose, deadline)) ?? findWorkspace(info, purpose, deadline);
}

async function statusOf(info: LaneHome): Promise<Status> {
  const { lane, home } = info;
  try {
    if ((await workspaceOf(info, "liveness"))?.state === "running")
      return { lane, state: "running" };
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
    const mate = (await workspaceOf(info, "placement")) !== undefined;
    out.push({
      lane: info.lane,
      mate,
      ...(info.config.host === undefined ? {} : { host: info.config.host }),
    });
  }
  return out;
}

function syncHome(root: string, home: string, deadline?: number): void {
  const target = gitWithin(root, ["rev-parse", "HEAD"], deadline);
  const inHome = (...args: string[]) => gitWithin(home, args, deadline);
  if (inHome("rev-parse", "HEAD") === target || inHome("status", "--porcelain") !== "") return;
  inHome("checkout", "--detach", target);
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
const LAUNCH_WAIT_MS = 10_000;
const START_RECORD_MS = 1_000;

async function untilPiShows(pane: string, maintenance: boolean): Promise<void> {
  const deadline = performance.now() + SHELL_WAIT_MS;
  while (
    remainingMs(deadline) > 0 &&
    (await lanePaneState(pane, maintenance ? deadline : undefined).catch(
      ifUnread("unread" as const),
    )) !== "pi"
  ) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remainingMs(deadline))));
  }
}

async function createMatePane(info: LaneHome, deadline?: number): Promise<string> {
  const title = mateTitle(info.lane);
  const created = await laneHerdr(
    ["workspace", "create", "--cwd", info.home, "--label", title, "--no-focus"],
    "mutate",
    deadline,
  );
  const root = created["root_pane"];
  const pane = field(isRecord(root) ? root : undefined, "pane_id");
  if (pane === undefined || pane === "") throw new Error(`workspace ${title} has no pane`);
  return pane;
}

async function start(
  root: string,
  info: LaneHome,
  existingPane: string | undefined,
  lift: boolean,
  deadline?: number,
): Promise<void> {
  const launchDeadline =
    deadline === undefined ? undefined : deadline - SHELL_WAIT_MS - START_RECORD_MS;
  if (remainingMs(launchDeadline) < LAUNCH_WAIT_MS)
    throw new HostUnread("not enough maintenance time to start the lane");
  syncHome(root, info.home, launchDeadline);
  const pane = existingPane ?? (await createMatePane(info, launchDeadline));
  const pi = ["pi", "--continue", TRUST_ARG, ...mateStartArgs(info.config.args, info.config.tier)];
  const { direnv } = info.config;
  const command = withCompileCache(direnv === undefined ? pi : ["direnv", "exec", direnv, ...pi]);
  await laneHerdr(
    ["pane", "run", pane, `cd ${quote(info.home)} && ${command.map(quote).join(" ")}`],
    "mutate",
    launchDeadline,
  );
  if (lift) liftHold(info.home);
  mkdirSync(join(info.home, "state"), { recursive: true });
  const starts = [...recentStarts(info.home, Date.now()), Date.now()];
  writeFileSync(startsFile(info.home), `${starts.join("\n")}\n`);
  await untilPiShows(pane, deadline !== undefined);
  const host = info.config.host ?? process.env["FLEET_HOST"] ?? "local";
  if (deadline === undefined) await arrangeHere(host).catch(() => undefined);
  else {
    const timeout = remainingMs(deadline);
    if (timeout > 0) {
      const launch = fileURLToPath(new URL("./launch.ts", import.meta.url));
      await onHost("local", [process.execPath, launch, "arrange", "--host", host], timeout).catch(
        () => undefined,
      );
    }
  }
}

const named = (root: string, lane: string | undefined): LaneHome[] => {
  const all = laneHomes(root);
  const found = lane === undefined ? all : all.filter((each) => each.lane === lane);
  if (lane !== undefined && found.length === 0) throw new Error(`no lane ${lane} on this host`);
  return found;
};

async function upOne(
  root: string,
  info: LaneHome,
  only: string | undefined,
  deadline?: number,
): Promise<Outcome> {
  const { lane, home } = info;
  const observed = await workspaceOf(info, "liveness", deadline);
  const reason = heldReason(home);
  if (observed?.state === "running") {
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
  await start(root, info, observed?.state === "idle" ? observed.pane : undefined, lift, deadline);
  return { lane, action: "started" };
}

export async function up(
  root: string,
  only: string | undefined,
  deadline?: number,
): Promise<SweepResult> {
  const outcomes: Outcome[] = [];
  for (const info of named(root, only)) {
    try {
      outcomes.push(
        await withLifecycleLock(
          info.home,
          info.lane,
          () => upOne(root, info, only, deadline),
          deadline,
        ),
      );
    } catch (error) {
      if (deadline === undefined) throw error;
      if (!(error instanceof HostUnread))
        return { outcomes, failed: error instanceof Error ? error.message : String(error) };
      outcomes.push({ lane: info.lane, action: "unread" });
    }
  }
  return { outcomes };
}

async function close(info: LaneHome, workspace: string): Promise<void> {
  await claimFollowers(info.lane, workspace).catch(() => undefined);
  await laneHerdr(["workspace", "close", workspace], "mutate");
}

export async function stop(root: string, lane: string): Promise<void> {
  for (const info of named(root, lane)) {
    await withLifecycleLock(info.home, info.lane, async () => {
      const match = await workspaceOf(info, "close");
      mkdirSync(join(info.home, "state"), { recursive: true });
      writeFileSync(stoppedFile(info.home), "stopped by hand\n");
      if (match !== undefined) await close(info, match.workspace);
    });
  }
}

async function restartOne(root: string, info: LaneHome, all: boolean): Promise<Outcome> {
  const held = heldReason(info.home);
  const match = await workspaceOf(info, all && held !== undefined ? "restart-held" : "close");
  if (all && held !== undefined && match === undefined)
    return { lane: info.lane, action: "stopped", detail: held };
  if (match !== undefined) await close(info, match.workspace);
  const observed = await workspaceOf(info, "liveness");
  if (observed?.state === "running") {
    if (held !== undefined) liftHold(info.home);
    return { lane: info.lane, action: "running" };
  }
  await start(root, info, observed?.state === "idle" ? observed.pane : undefined, true);
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

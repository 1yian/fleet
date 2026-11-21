import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { quote } from "@fleet/protocol/route";
import { arrangeHere, claimFollowers } from "./arrange.ts";
import { TRUST_ARG } from "./fleet-args.ts";
import { field, HostUnread, laneHerdr, onHost } from "./host.ts";
import {
  discoverLanes,
  gitWithin,
  homeOf,
  unreadFailure,
  type Discovery,
  type LaneHome,
} from "./lane-homes.ts";
import {
  CRASH_WINDOW_MS,
  confirmLifecycle,
  heldReasonOf,
  readState,
  recentStartsOf,
  sampleLifecycle,
  startsFile,
  stoppedFile,
  type Lifecycle,
} from "./lane-lifecycle.ts";
import { idlePaneOf, lanePaneState, workspaceOf } from "./lane-observation.ts";
import { withLifecycleLock } from "./lifecycle-lock.ts";
import {
  isRecord,
  LANE_FILE,
  mateStartArgs,
  parseLaneConfig,
  type LaneConfig,
} from "./lane-config.ts";
import { remainingMs } from "./maintenance-budget.ts";
import { withCompileCache } from "./scratch.ts";
import { mateTitle } from "./titles.ts";

export {
  codeRoot,
  discoverLanes,
  existingHome,
  homeOf,
  laneHomes,
  unreadFailure,
} from "./lane-homes.ts";

const git = (cwd: string, ...args: string[]): string => gitWithin(cwd, args);

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
  readonly expected: string[];
  readonly outcomes: Outcome[];
  readonly failed?: string;
}

const STARTS_BEFORE_HOLD = 3;

const HELD_AT_CREATION = "held since the home was made\n";

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

const ifUnread =
  <T>(fallback: T) =>
  (error: unknown): T => {
    if (error instanceof HostUnread) return fallback;
    throw error;
  };

function heldReason(home: string): string | undefined {
  return heldReasonOf(readState(stoppedFile(home), "state/stopped"));
}

async function statusOf(info: LaneHome): Promise<Status> {
  const { lane, home } = info;
  try {
    const before = sampleLifecycle(home);
    const reason = heldReasonOf(before[0]);
    recentStartsOf(before[1], Date.now());
    const observed = await workspaceOf(info, "liveness");
    if (sampleLifecycle(home).some((text, at) => text !== before[at]))
      throw new HostUnread(`${lane} lifecycle state changed while its status was being read`);
    if (observed?.state === "running") return { lane, state: "running" };
    return reason === undefined ? { lane, state: "down" } : { lane, state: "stopped", reason };
  } catch (error) {
    if (error instanceof HostUnread) return { lane, state: "unknown", reason: error.message };
    throw error;
  }
}

export async function status(root: string): Promise<Status[]> {
  const { homes, unread } = discoverLanes(root);
  const out: Status[] = [];
  for (const info of homes) out.push(await statusOf(info));
  for (const { lane, message } of unread) out.push({ lane, state: "unknown", reason: message });
  return out;
}

export async function placementStatus(
  root: string,
): Promise<{ lane: string; mate: boolean; host?: string }[]> {
  const { homes, unread } = discoverLanes(root);
  if (unread.length > 0) throw new Error(unreadFailure(unread));
  const out: { lane: string; mate: boolean; host?: string }[] = [];
  for (const info of homes) {
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
  return recentStartsOf(readState(startsFile(home), "state/starts"), now);
}

const LANE_OBSERVATION_MS = 18_000;
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

class AcceptedStartFailure extends Error {
  readonly lane: string;

  constructor(lane: string, error: unknown) {
    super(
      `${lane} started, but recording the start failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    this.lane = lane;
  }
}

function startDeadline(deadline: number | undefined): number | undefined {
  const limit = deadline === undefined ? undefined : deadline - SHELL_WAIT_MS - START_RECORD_MS;
  if (remainingMs(limit) < LAUNCH_WAIT_MS)
    throw new HostUnread("not enough maintenance time to start the lane");
  return limit;
}

async function confirmTarget(
  info: LaneHome,
  expected: string | undefined,
  deadline: number | undefined,
): Promise<void> {
  const now = await workspaceOf(info, "liveness", deadline);
  if (idlePaneOf(now) !== expected || (now === undefined) !== (expected === undefined))
    throw new HostUnread(`${info.lane} changed while its start was being prepared`);
}

const noClaimCheck = (): void => undefined;

function confirmClaim(root: string, info: LaneHome): void {
  let now: LaneHome | undefined;
  try {
    now = discoverLanes(root).homes.find((each) => each.lane === info.lane);
  } catch {
    throw new HostUnread(`${info.lane} claim could not be read again after it was checked`);
  }
  if (now?.home !== info.home || JSON.stringify(now.config) !== JSON.stringify(info.config))
    throw new HostUnread(`${info.lane} claim changed or became ambiguous after it was checked`);
}

async function createConfirmedPane(
  info: LaneHome,
  deadline: number | undefined,
  confirm: (info: LaneHome, sample: Lifecycle) => void,
  sample: Lifecycle,
): Promise<string> {
  confirm(info, sample);
  const pane = await createMatePane(info, deadline);
  await confirmTarget(info, pane, deadline);
  return pane;
}

async function start(
  root: string,
  info: LaneHome,
  existingPane: string | undefined,
  lift: boolean,
  sample: Lifecycle,
  deadline?: number,
  confirm: (info: LaneHome, sample: Lifecycle) => void = noClaimCheck,
): Promise<void> {
  const launchDeadline = startDeadline(deadline);
  const history = recentStartsOf(sample[1], Date.now());
  syncHome(root, info.home, launchDeadline);
  await confirmTarget(info, existingPane, launchDeadline);
  const pane = existingPane ?? (await createConfirmedPane(info, launchDeadline, confirm, sample));
  confirm(info, sample);
  const pi = ["pi", "--continue", TRUST_ARG, ...mateStartArgs(info.config.args, info.config.tier)];
  const { direnv } = info.config;
  const command = withCompileCache(direnv === undefined ? pi : ["direnv", "exec", direnv, ...pi]);
  await laneHerdr(
    ["pane", "run", pane, `cd ${quote(info.home)} && ${command.map(quote).join(" ")}`],
    "mutate",
    launchDeadline,
  );
  let bookkeeping: unknown;
  try {
    if (lift) liftHold(info.home);
    mkdirSync(join(info.home, "state"), { recursive: true });
    const starts = [...(lift ? [] : history), Date.now()];
    replaceFile(startsFile(info.home), `${starts.join("\n")}\n`);
  } catch (error) {
    bookkeeping = error;
  }
  await untilPiShows(pane, deadline !== undefined);
  await arrangeAfterStart(info.config.host ?? process.env["FLEET_HOST"] ?? "local", deadline);
  if (bookkeeping !== undefined) throw new AcceptedStartFailure(info.lane, bookkeeping);
}

async function arrangeAfterStart(host: string, deadline?: number): Promise<void> {
  if (deadline === undefined) {
    await arrangeHere(host).catch(() => undefined);
    return;
  }
  const timeout = remainingMs(deadline);
  if (timeout === 0) return;
  const launch = fileURLToPath(new URL("./launch.ts", import.meta.url));
  await onHost("local", [process.execPath, launch, "arrange", "--host", host], timeout, true).catch(
    () => undefined,
  );
}

const named = (root: string, lane: string | undefined, discovered?: Discovery): Discovery => {
  const all = discovered ?? discoverLanes(root);
  if (lane === undefined) return all;
  const found = {
    homes: all.homes.filter((each) => each.lane === lane),
    unread: all.unread.filter((each) => each.lane === lane),
  };
  if (found.homes.length + found.unread.length === 0)
    throw new Error(`no lane ${lane} on this host`);
  return found;
};

async function upOne(
  root: string,
  info: LaneHome,
  only: string | undefined,
  deadline: number | undefined,
  confirm: (info: LaneHome, sample: Lifecycle) => void,
): Promise<Outcome> {
  const { lane, home } = info;
  const observationDeadline =
    deadline === undefined
      ? undefined
      : Math.min(deadline, performance.now() + LANE_OBSERVATION_MS);
  const sample = sampleLifecycle(home);
  confirm(info, sample);
  const observed = await workspaceOf(info, "liveness", observationDeadline);
  confirm(info, sample);
  const reason = heldReasonOf(sample[0]);
  const history = recentStartsOf(sample[1], Date.now());
  if (observed?.state === "running") {
    if (reason !== undefined) liftHold(home);
    return { lane, action: "running" };
  }
  const lift = only !== undefined && reason !== undefined;
  if (reason !== undefined && !lift) return { lane, action: "stopped", detail: reason };
  if (!lift && history.length >= STARTS_BEFORE_HOLD) {
    const detail = `started ${String(STARTS_BEFORE_HOLD)} times in ${String(CRASH_WINDOW_MS / 60_000)} minutes`;
    writeFileSync(stoppedFile(home), `crash loop: ${detail}\n`);
    return { lane, action: "held", detail };
  }
  await start(root, info, idlePaneOf(observed), lift, sample, deadline, confirm);
  return { lane, action: "started" };
}

export async function up(
  root: string,
  only: string | undefined,
  deadline?: number,
  offset = 0,
  discovered?: Discovery,
): Promise<SweepResult> {
  const { homes: lanes, unread } = named(root, only, discovered);
  const confirm =
    discovered === undefined
      ? noClaimCheck
      : (info: LaneHome, sample: Lifecycle): void => {
          confirmClaim(root, info);
          discovered.confirm?.(info);
          confirmLifecycle(info, sample);
        };
  const expected = [...lanes, ...unread].map(({ lane }) => lane);
  const unreadFailed = unreadFailure(unread);
  const first = offset % Math.max(1, lanes.length);
  const outcomes: Outcome[] = [];
  for (const info of [...lanes.slice(first), ...lanes.slice(0, first)]) {
    try {
      outcomes.push(
        await withLifecycleLock(
          info.home,
          info.lane,
          () => upOne(root, info, only, deadline, confirm),
          deadline,
        ),
      );
    } catch (error) {
      if (deadline === undefined) throw error;
      if (error instanceof AcceptedStartFailure)
        outcomes.push({ lane: error.lane, action: "started" });
      if (!(error instanceof HostUnread))
        return {
          expected,
          outcomes,
          failed: [messageOf(error), unreadFailed].filter(Boolean).join("\n"),
        };
      outcomes.push({ lane: info.lane, action: "unread" });
    }
  }
  return { expected, outcomes, ...(unreadFailed === "" ? {} : { failed: unreadFailed }) };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function close(info: LaneHome, workspace: string): Promise<void> {
  await claimFollowers(info.lane, workspace).catch(() => undefined);
  await laneHerdr(["workspace", "close", workspace], "mutate");
}

export async function stop(root: string, lane: string): Promise<void> {
  const { homes, unread } = named(root, lane);
  if (unread.length > 0) throw new Error(unreadFailure(unread));
  for (const info of homes) {
    await withLifecycleLock(info.home, info.lane, async () => {
      heldReason(info.home);
      recentStarts(info.home, Date.now());
      const match = await workspaceOf(info, "close");
      mkdirSync(join(info.home, "state"), { recursive: true });
      writeFileSync(stoppedFile(info.home), "stopped by hand\n");
      if (match !== undefined) await close(info, match.workspace);
    });
  }
}

async function restartOne(root: string, info: LaneHome, all: boolean): Promise<Outcome> {
  const held = heldReason(info.home);
  recentStarts(info.home, Date.now());
  const keepHeld = all ? held : undefined;
  const match = await workspaceOf(info, keepHeld === undefined ? "close" : "restart-held");
  if (keepHeld !== undefined && match?.state !== "running")
    return { lane: info.lane, action: "stopped", detail: keepHeld };
  if (match !== undefined) await close(info, match.workspace);
  const observed = await workspaceOf(info, "liveness");
  if (observed?.state === "running")
    throw new HostUnread(
      `${info.lane} still has a running mate in workspace ${observed.workspace} after restart closed its own`,
    );
  await start(root, info, idlePaneOf(observed), true, sampleLifecycle(info.home));
  return { lane: info.lane, action: "started" };
}

export async function restart(root: string, lane: string | undefined): Promise<Outcome[]> {
  const { homes, unread } = named(root, lane);
  if (unread.length > 0) throw new Error(unreadFailure(unread));
  const out: Outcome[] = [];
  for (const info of homes)
    out.push(
      await withLifecycleLock(info.home, info.lane, () =>
        restartOne(root, info, lane === undefined),
      ),
    );
  return out;
}

import type { Delivery, OpResult } from "@fleet/protocol";
import { releaseBrowser } from "./browser-release.ts";
import { SYNC_FUNCTIONS } from "./clones.ts";
import { contain, releaseAll } from "./containment.ts";
import { extensionOn } from "./extension-path.ts";
import { fleetArgs } from "./fleet-args.ts";
import {
  field,
  herdr,
  onHost,
  paneMissing,
  paneText,
  piPids,
  piRunning,
  records,
  scrub,
  shellIdle,
  worktreeOf,
} from "./host.ts";
import { openWorkerWorkspace } from "./place.ts";
import { OPEN_SCRATCH_SCRIPT, parseOpened, workerEnvironment } from "./scratch.ts";
import type { Link } from "./link.ts";
import { workerModelArgs } from "./lane-config.ts";

export interface Launch {
  readonly url: string;
  readonly piArgs: readonly string[];
  readonly extension: string;
  readonly lost: (text: string) => void;
}

type Plan = OpResult<"attempt.begin">;

const ADD_WORKTREE = `${SYNC_FUNCTIONS}
set -eu
clone=$1 path=$2 branch=$3 base=$4 from=$5
if git -C "$clone" show-ref --verify -q "refs/heads/$branch"; then
  git -C "$clone" worktree add -q "$path" "$branch"
  exit 0
fi
start=$base
if [ "$from" = origin ] && git -C "$clone" remote get-url origin >/dev/null 2>&1; then
  if ! fetch_origin "$clone"; then
    echo "could not fetch origin in $clone, so the worker would start from a stale base: $(fetch_reason)" >&2
    exit 1
  fi
  start=origin/$base
  if ! git -C "$clone" rev-parse -q --verify "refs/remotes/$start^{commit}" >/dev/null; then
    echo "origin of $clone has no branch $base to start from" >&2
    exit 1
  fi
fi
git -C "$clone" worktree add -q --no-track -b "$branch" "$path" "$start"`;

async function scratchEnvironment(host: string, card: number): Promise<string[]> {
  const opened = await onHost(host, ["sh", "-c", OPEN_SCRATCH_SCRIPT, "scratch", String(card)]);
  return workerEnvironment(parseOpened(opened));
}

async function worktreePane(
  host: string,
  plan: Plan,
  card: number,
): Promise<{ pane: string; path: string }> {
  const tree = worktreeOf(
    await herdr(host, ["worktree", "list", "--cwd", plan.clone]),
    plan.session,
  );
  const workspace = field(tree, "open_workspace_id");
  const path = field(tree, "path") ?? `${plan.clone}.worktrees/${plan.session}`;
  if (workspace !== undefined) {
    const panes = records((await herdr(host, ["pane", "list", "--workspace", workspace]))["panes"]);
    const pane = field(panes[0], "pane_id");
    if (pane === undefined) throw new Error(`workspace ${workspace} on ${host} has no pane`);
    return { pane, path };
  }
  if (tree === undefined) {
    const from = plan.delivery === "local-only" ? "local" : "origin";
    const args = [plan.clone, path, plan.branch, plan.base, from];
    await onHost(host, ["sh", "-c", ADD_WORKTREE, "add", ...args]);
  }
  const root = await openWorkerWorkspace(
    host,
    path,
    { id: card, name: plan.name, lane: plan.lane },
    await scratchEnvironment(host, card),
  );
  return { pane: root, path };
}

const SHELL_WAIT_MS = 20_000;

const HERDR_READY_WAIT_MS = 4000;

const PI_NAME_WAIT_MS = 10_000;

const LAUNCH_TRIES = 2;

const toError = (failure: unknown): Error =>
  failure instanceof Error ? failure : new Error(String(failure));

const refused = (error: Error): boolean =>
  /"code":"agent_(pane_busy|name_taken)"/.test(error.message);

const POLL_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => Promise<boolean>, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (!(await check())) {
    if (Date.now() > deadline) return false;
    await sleep(POLL_MS);
  }
  return true;
}

async function launchOnce(host: string, pane: string, args: string[]): Promise<Error | undefined> {
  const launched = until(() => shellIdle(host, pane), SHELL_WAIT_MS)
    .then(() => herdr(host, args))
    .then(() => undefined, toError);
  const watch = { over: false };
  const appeared = (async (): Promise<undefined> => {
    while (!watch.over && !(await piRunning(host, pane).catch(() => false))) await sleep(POLL_MS);
    return undefined;
  })();
  try {
    return await Promise.race([launched, appeared]);
  } finally {
    watch.over = true;
  }
}

const STAY_MS = 3000;

const EXIT_LINES = 20;

async function exitedMessage(
  host: string,
  pane: string,
  worker: { session: string; token: string },
): Promise<string> {
  const text = await paneText(host, pane).catch(() => "");
  const lines = scrub(text, [worker.token])
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  const shown = lines.slice(-EXIT_LINES).join("\n");
  return `Pi is not running in pane ${pane} on ${host} after ${worker.session} was started in it, so the worker never connected. The pane is still open. Last lines of the pane:\n${shown}`;
}

async function confirmStays(
  host: string,
  pane: string,
  worker: { session: string; token: string },
): Promise<void> {
  const deadline = Date.now() + STAY_MS;
  while (Date.now() < deadline) {
    if (!(await piRunning(host, pane).catch(() => true))) {
      if (await paneMissing(host, pane).catch(() => true)) return;
      throw new Error(await exitedMessage(host, pane, worker));
    }
    await sleep(POLL_MS);
  }
}

async function startAgent(
  host: string,
  pane: string,
  args: string[],
  worker: { session: string; token: string },
  lost: (text: string) => void,
): Promise<void> {
  try {
    await launchAgent(host, pane, args);
  } catch (error) {
    if (await piRunning(host, pane).catch(() => true)) throw error;
    throw new Error(await exitedMessage(host, pane, worker), { cause: error });
  }
  confirmStays(host, pane, worker).catch((error: unknown) => {
    lost(error instanceof Error ? error.message : String(error));
  });
}

async function launchAgent(host: string, pane: string, args: string[]): Promise<void> {
  const deadline = Date.now() + SHELL_WAIT_MS;
  for (let tries = 1; ;) {
    const error = await launchOnce(host, pane, args);
    if (error === undefined) return;
    if (refused(error) && Date.now() < deadline) {
      await sleep(POLL_MS);
      continue;
    }
    if (await until(() => piRunning(host, pane), PI_NAME_WAIT_MS)) return;
    if (tries === LAUNCH_TRIES) throw error;
    tries += 1;
  }
}

export async function dispatch(
  link: Link,
  launch: Launch,
  request: {
    card: number;
    host: string;
    task: string;
    delivery?: Delivery | undefined;
    model?: string | undefined;
  },
): Promise<string> {
  const extension = await extensionOn(request.host, launch.extension);
  const plan = await link.call("attempt.begin", request);
  const where = `${plan.session} on ${request.host}`;
  const { pane, path } = await worktreePane(request.host, plan, request.card);
  await contain(request.host, pane, path);
  if (await piRunning(request.host, pane)) {
    return `Found ${where} already starting.`;
  }
  await startAgent(
    request.host,
    pane,
    [
      [
        "agent",
        "start",
        plan.session,
        "--kind",
        "pi",
        "--pane",
        pane,
        "--timeout",
        String(HERDR_READY_WAIT_MS),
        "--",
      ],
      fleetArgs({ url: launch.url, token: plan.token, role: "worker" }),
      [
        "--session-id",
        plan.session,
        "-e",
        extension,
        ...workerModelArgs(launch.piArgs, plan.model),
      ],
    ].flat(),
    plan,
    launch.lost,
  );
  await contain(request.host, pane, path);
  return `Dispatched ${where}, branch ${plan.branch}.`;
}

const STOP_WAIT_MS = 15_000;

async function stopPi(host: string, pane: string, session: string): Promise<void> {
  const signals = ["TERM", "KILL"] as const;
  for (const signal of signals) {
    for (const pid of await piPids(host, pane))
      await onHost(host, ["kill", `-${signal}`, String(pid)]).catch(() => undefined);
    if (await until(() => shellIdle(host, pane), STOP_WAIT_MS)) return;
  }
  throw new Error(
    `could not confirm that the old process of ${session} stopped, so nothing was started in its place`,
  );
}

async function closeWorkspace(host: string, clone: string, session: string): Promise<void> {
  const tree = worktreeOf(await herdr(host, ["worktree", "list", "--cwd", clone]), session);
  const workspace = field(tree, "open_workspace_id");
  if (workspace !== undefined) await herdr(host, ["workspace", "close", workspace]);
}

export async function replaceWorker(
  link: Link,
  launch: Launch,
  recovery: { card: number; host: string; repeat: boolean },
  avoid: readonly string[] = [],
): Promise<string> {
  const plan = await link.call("attempt.resume", { card: recovery.card });
  if (!plan.resumed) throw new Error(`${plan.session} had no live attempt to replace`);
  if (recovery.repeat)
    return `A process of ${plan.session} already runs or is starting on ${recovery.host}, so this repeated request left it alone.`;
  const extension = await extensionOn(recovery.host, launch.extension);
  const old = await worktreePane(recovery.host, plan, recovery.card);
  if (await piRunning(recovery.host, old.pane)) await stopPi(recovery.host, old.pane, plan.session);
  await closeWorkspace(recovery.host, plan.clone, plan.session);
  await releaseAll(recovery.host, old.path);
  const browser = await releaseBrowser(link, recovery.card);
  const { pane, path } = await worktreePane(recovery.host, plan, recovery.card);
  await contain(recovery.host, pane, path);
  await startAgent(
    recovery.host,
    pane,
    [
      [
        "agent",
        "start",
        plan.session,
        "--kind",
        "pi",
        "--pane",
        pane,
        "--timeout",
        String(HERDR_READY_WAIT_MS),
        "--",
      ],
      fleetArgs({ url: launch.url, token: plan.token, role: "worker", avoid }),
      [
        "--session-id",
        plan.session,
        "-e",
        extension,
        ...workerModelArgs(launch.piArgs, plan.model),
      ],
    ].flat(),
    plan,
    launch.lost,
  );
  await contain(recovery.host, pane, path);
  return `Started ${plan.session} again on ${recovery.host}, on its own session and branch ${plan.branch}.${browser}`;
}

import type { Delivery, OpResult } from "@fleet/protocol";
import { ADD_WORKTREE } from "./clones.ts";
import { contain, releaseAll } from "./containment.ts";
import { extensionOn } from "./extension-path.ts";
import { fleetArgs, TRUST_ARG } from "./fleet-args.ts";
import {
  field,
  herdr,
  onHost,
  paneText,
  piPids,
  piRunning,
  records,
  scrub,
  shellIdle,
  worktreeOf,
} from "./host.ts";
import { claimWorkspace, openWorkerWorkspace } from "./place.ts";
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

async function scratchEnvironment(host: string, card: number): Promise<string[]> {
  const opened = await onHost(host, ["sh", "-c", OPEN_SCRATCH_SCRIPT, "scratch", String(card)]);
  return workerEnvironment(parseOpened(opened));
}

async function worktreePane(
  host: string,
  plan: Plan,
  card: number,
): Promise<{ pane: string; path: string; workspace: string | undefined }> {
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
    return { pane, path, workspace };
  }
  if (tree === undefined) {
    const from = plan.delivery === "local-only" || plan.delivery === "ops" ? "local" : "origin";
    const args = [plan.clone, path, plan.branch, plan.base, from];
    await onHost(host, ["sh", "-c", ADD_WORKTREE, "add", ...args]);
  }
  const opened = await openWorkerWorkspace(
    host,
    path,
    { name: plan.name },
    await scratchEnvironment(host, card),
  );
  return { pane: opened.pane, path, workspace: opened.workspace };
}

async function claimOwned(
  host: string,
  workspace: string | undefined,
  plan: Plan,
  card: number,
): Promise<void> {
  if (workspace !== undefined) await claimWorkspace(host, workspace, { id: card, lane: plan.lane });
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

type RetryGuard = (error: unknown) => Promise<void>;

async function launchOnce(
  host: string,
  pane: string,
  args: string[],
  guard: RetryGuard | undefined,
  previous: Error | undefined,
): Promise<Error | undefined> {
  const watch = { over: false };
  const launched = until(() => shellIdle(host, pane), SHELL_WAIT_MS).then(async () => {
    if (guard !== undefined && previous !== undefined) {
      await guard(previous);
      if (watch.over) return;
    }
    try {
      await herdr(host, args, false, guard);
      return undefined;
    } catch (error) {
      return toError(error);
    }
  }, toError);
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
    if (await shellIdle(host, pane).catch(() => false))
      throw new Error(await exitedMessage(host, pane, worker));
    await sleep(POLL_MS);
  }
}

export class DidNotStart extends Error {}

class StartedBeforeReady extends Error {
  constructor(error: unknown) {
    super(`${toError(error).message}\nThe replacement connected before readiness failed.`, {
      cause: error,
    });
  }
}

type ReplacementStarted = () => Promise<boolean | undefined>;

async function startAgent(
  host: string,
  pane: string,
  args: string[],
  worker: { session: string; token: string },
  lost: (text: string) => void,
  replacementStarted?: ReplacementStarted,
): Promise<void> {
  try {
    await launchAgent(host, pane, args, replacementStarted);
  } catch (error) {
    if (error instanceof StartedBeforeReady) throw error;
    const running = await piRunning(host, pane).catch(() => undefined);
    if (running === true || (running === undefined && replacementStarted === undefined))
      throw error;
    if ((await replacementStarted?.()) === true) throw new StartedBeforeReady(error);
    const message =
      running === undefined ? toError(error).message : await exitedMessage(host, pane, worker);
    throw new DidNotStart(message, { cause: error });
  }
  confirmStays(host, pane, worker).catch((error: unknown) => {
    lost(error instanceof Error ? error.message : String(error));
  });
}

async function launchAgent(
  host: string,
  pane: string,
  args: string[],
  replacementStarted?: ReplacementStarted,
): Promise<void> {
  const deadline = Date.now() + SHELL_WAIT_MS;
  const guard =
    replacementStarted === undefined
      ? undefined
      : async (error: unknown) => {
          const started = await replacementStarted();
          if (started === true) throw new StartedBeforeReady(error);
          if (started === undefined) throw toError(error);
        };
  let previous: Error | undefined;
  for (let tries = 1; ;) {
    const error = await launchOnce(host, pane, args, guard, previous);
    if (error === undefined) return;
    if (error instanceof StartedBeforeReady) throw error;
    previous = error;
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
  const { pane, path, workspace } = await worktreePane(request.host, plan, request.card);
  await claimOwned(request.host, workspace, plan, request.card);
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
      fleetArgs({
        url: launch.url,
        token: plan.token,
        role: "worker",
        fleetProject: plan.fleetProject,
      }),
      [
        TRUST_ARG,
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

interface Recovery {
  card: number;
  host: string;
  actor: string;
  generation: number;
  repeat: boolean;
  notice?: number | undefined;
}

interface Replacement {
  plan: Plan;
  pane: string;
  path: string;
  extension: string;
}

async function freshPane(plan: Plan, recovery: Recovery): Promise<{ pane: string; path: string }> {
  const old = await worktreePane(recovery.host, plan, recovery.card);
  if (await piRunning(recovery.host, old.pane)) await stopPi(recovery.host, old.pane, plan.session);
  await closeWorkspace(recovery.host, plan.clone, plan.session);
  await releaseAll(recovery.host, old.path);
  const { pane, path, workspace } = await worktreePane(recovery.host, plan, recovery.card);
  await claimOwned(recovery.host, workspace, plan, recovery.card);
  await contain(recovery.host, pane, path);
  return { pane, path };
}

async function prepareReplacement(
  link: Link,
  launch: Launch,
  recovery: Recovery,
): Promise<string | Replacement> {
  const plan = await link.call("attempt.resume", { card: recovery.card });
  if (!plan.resumed) throw new Error(`${plan.session} had no live attempt to replace`);
  if (recovery.repeat)
    return `A process of ${plan.session} already runs or is starting on ${recovery.host}, so this repeated request left it alone.`;
  const extension = await extensionOn(recovery.host, launch.extension);
  const fresh = await freshPane(plan, recovery);
  if (recovery.notice !== undefined)
    await link.call("card.restart.notice", { card: recovery.card, request: recovery.notice });
  return { plan, ...fresh, extension };
}

export async function replaceWorker(
  link: Link,
  launch: Launch,
  recovery: Recovery,
  avoid: readonly string[] = [],
): Promise<string> {
  const fresh = await prepareReplacement(link, launch, recovery).catch((error: unknown) => {
    throw new DidNotStart(toError(error).message, { cause: error });
  });
  if (typeof fresh === "string") return fresh;
  const { plan, pane, path, extension } = fresh;
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
      fleetArgs({
        url: launch.url,
        token: plan.token,
        role: "worker",
        fleetProject: plan.fleetProject,
        avoid,
      }),
      [
        TRUST_ARG,
        "--session-id",
        plan.session,
        "-e",
        extension,
        ...workerModelArgs(launch.piArgs, plan.model),
      ],
    ].flat(),
    plan,
    launch.lost,
    async () => {
      const current = await link
        .call("attempt.resume", { card: recovery.card })
        .catch(() => undefined);
      return current?.session === recovery.actor
        ? current.generation > recovery.generation
        : undefined;
    },
  );
  await contain(recovery.host, pane, path);
  return `Started ${plan.session} again on ${recovery.host}, on its own session and branch ${plan.branch}.`;
}

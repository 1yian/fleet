import { randomUUID } from "node:crypto";
import type { Delivery, OpResult } from "@fleet/protocol";
import { ADD_WORKTREE } from "./clones.ts";
import { contain, releaseAll } from "./containment.ts";
import { extensionOn } from "./extension-path.ts";
import { fleetArgs, TRUST_ARG } from "./fleet-args.ts";
import {
  AgentReadinessTimedOut,
  AgentStartRefused,
  field,
  herdr,
  onHost,
  paneText,
  piPids,
  piRunning,
  records,
  scrub,
  shellIdle,
  startReplacementOnce,
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
const restartShellWait = Number(process.env["FLEET_RESTART_SHELL_WAIT_MS"]);
const RESTART_SHELL_WAIT_MS =
  Number.isSafeInteger(restartShellWait) && restartShellWait > 0
    ? Math.min(restartShellWait, SHELL_WAIT_MS)
    : SHELL_WAIT_MS;

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

class StartUnconfirmed extends Error {
  readonly timedOut: boolean;

  constructor(cause: unknown) {
    super(toError(cause).message, { cause });
    this.timedOut = cause instanceof AgentReadinessTimedOut;
  }
}

async function launchReplacement(host: string, pane: string, args: string[]): Promise<void> {
  let idle: boolean;
  try {
    idle = await until(() => shellIdle(host, pane), RESTART_SHELL_WAIT_MS);
  } catch (error) {
    throw new DidNotStart(error);
  }
  if (!idle)
    throw new DidNotStart(new Error(`the shell in pane ${pane} on ${host} did not become idle`));
  try {
    await startReplacementOnce(host, args);
  } catch (error) {
    throw error instanceof AgentStartRefused ? error : new StartUnconfirmed(error);
  }
}

async function launchOnce(host: string, pane: string, args: string[]): Promise<Error | undefined> {
  const watch = { over: false };
  const launched = until(() => shellIdle(host, pane), SHELL_WAIT_MS)
    .then(() => herdr(host, args))
    .then(() => undefined, toError);
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

async function paneTail(host: string, pane: string, token: string): Promise<string> {
  const text = await paneText(host, pane).catch(() => "");
  const lines = scrub(text, [token])
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  return `The pane is still open. Last lines of the pane:\n${lines.slice(-EXIT_LINES).join("\n")}`;
}

async function exitedMessage(
  host: string,
  pane: string,
  worker: { session: string; token: string },
  connected: boolean,
): Promise<string> {
  const what = connected
    ? `after ${worker.session} connected to Fleet`
    : `after ${worker.session} was started in it, so the worker never connected`;
  return `Pi is not running in pane ${pane} on ${host} ${what}. ${await paneTail(host, pane, worker.token)}`;
}

async function confirmStays(
  host: string,
  pane: string,
  worker: { session: string; token: string },
  connected: boolean,
): Promise<void> {
  const deadline = Date.now() + STAY_MS;
  while (Date.now() < deadline) {
    if (await shellIdle(host, pane).catch(() => false))
      throw new Error(await exitedMessage(host, pane, worker, connected));
    await sleep(POLL_MS);
  }
}

export class DidNotStart extends Error {
  constructor(cause: unknown, context?: string, token = "") {
    const seen = new Set<Error>();
    const messages = new Set(context === undefined ? [] : [context]);
    let current = cause;
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current);
      messages.add(scrub(current.message, [token]));
      current = current.cause;
    }
    if (seen.size === 0) messages.add(scrub(String(cause), [token]));
    super([...messages].join("\n"), { cause });
  }
}

type ReplacementStarted = () => Promise<boolean | undefined>;

async function replacementError(
  host: string,
  pane: string,
  worker: { session: string; token: string },
  error: unknown,
  replacementStarted: ReplacementStarted,
): Promise<Error | string> {
  const running = await piRunning(host, pane).catch(() => undefined);
  const cause = scrub(toError(error).message, [worker.token]);
  const timedOut =
    error instanceof AgentReadinessTimedOut ||
    (error instanceof StartUnconfirmed && error.timedOut);
  if (timedOut && (await replacementStarted()) === true) return cause;
  if (running === true && !(error instanceof AgentStartRefused)) return toError(error);
  if (running === false && error instanceof StartUnconfirmed)
    return new Error(
      `${cause}\nThe replacement could not be confirmed after the start command; the request was not refunded.`,
      { cause: error },
    );
  const context =
    running === false
      ? `The replacement did not start. Pi is not running in pane ${pane} on ${host}. ${await paneTail(host, pane, worker.token)}`
      : undefined;
  return new DidNotStart(error, context, worker.token);
}

async function startAgent(
  host: string,
  pane: string,
  args: string[],
  worker: { session: string; token: string },
  lost: (text: string) => void,
  replacementStarted?: ReplacementStarted,
): Promise<string | undefined> {
  let readiness: string | undefined;
  try {
    if (replacementStarted === undefined) await launchAgent(host, pane, args);
    else await launchReplacement(host, pane, args);
  } catch (error) {
    if (replacementStarted !== undefined) {
      const outcome =
        error instanceof DidNotStart
          ? error
          : await replacementError(host, pane, worker, error, replacementStarted);
      if (outcome instanceof Error) throw outcome;
      readiness = outcome;
    } else {
      const running = await piRunning(host, pane).catch(() => undefined);
      if (running !== false) throw error;
      throw new Error(await exitedMessage(host, pane, worker, false), { cause: error });
    }
  }
  confirmStays(host, pane, worker, readiness !== undefined).catch((error: unknown) => {
    lost(error instanceof Error ? error.message : String(error));
  });
  return readiness;
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
        attempt: plan.session,
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
): Promise<Replacement> {
  const plan = await link.call("attempt.resume", { card: recovery.card });
  if (!plan.resumed) throw new Error(`${plan.session} had no live attempt to replace`);
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
  const { plan, pane, path, extension } = await prepareReplacement(link, launch, recovery).catch(
    (error: unknown) => {
      throw new DidNotStart(error);
    },
  );
  const launched = randomUUID();
  const readiness = await startAgent(
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
        attempt: plan.session,
        fleetProject: plan.fleetProject,
        avoid,
        launch: launched,
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
      return current?.session === recovery.actor ? current.process === launched : undefined;
    },
  );
  try {
    await contain(recovery.host, pane, path);
  } catch (error) {
    if (readiness === undefined) throw error;
    throw new Error(
      `${scrub(toError(error).message, [plan.token])}\nHerdr also reported:\n${readiness}`,
      { cause: error },
    );
  }
  const started = `Started ${plan.session} again on ${recovery.host}, on its own session and branch ${plan.branch}.`;
  return readiness === undefined
    ? started
    : `${started} The replacement connected to Fleet, but Herdr did not confirm interactive readiness; the restart still counts and was not relaunched. Herdr reported:\n${readiness}`;
}

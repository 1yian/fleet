// dispatch (spec section 11.2). cardd creates or finds the attempt. Then each
// host step first looks for its own result by the names that derive from the
// attempt ID, so a retry after a lost connection never starts a second worker.
import { check, OPS } from "@fleet/protocol";
import { fleetArgs } from "./fleet-args.ts";
import { field, herdr, onHost, piRunning, records, shellIdle, worktreeOf } from "./host.ts";
import { openWorkerWorkspace } from "./place.ts";
import type { Link } from "./link.ts";

export interface Launch {
  /** The cardd websocket URL that workers on other hosts can reach. */
  readonly url: string;
  /** Extra Pi arguments for workers, such as a model profile. */
  readonly piArgs: readonly string[];
}

type Plan = ReturnType<typeof parsePlan>;
const parsePlan = (value: unknown) => check(OPS["attempt.begin"].result, value);

// Adds the attempt's worktree on its task branch, or on the branch again if a
// cleanup removed only the worktree. Safe to rerun only through the lookup before it.
const ADD_WORKTREE = `set -eu
clone=$1 path=$2 branch=$3 base=$4
if git -C "$clone" show-ref --verify -q "refs/heads/$branch"; then
  git -C "$clone" worktree add -q "$path" "$branch"
else
  git -C "$clone" worktree add -q -b "$branch" "$path" "$base"
fi`;

/** The root pane of the attempt's worktree workspace, created if needed. */
async function worktreePane(host: string, plan: Plan): Promise<string> {
  const tree = worktreeOf(
    await herdr(host, ["worktree", "list", "--cwd", plan.clone]),
    plan.session,
  );
  const workspace = field(tree, "open_workspace_id");
  if (workspace !== undefined) {
    const panes = records((await herdr(host, ["pane", "list", "--workspace", workspace]))["panes"]);
    const pane = field(panes[0], "pane_id");
    if (pane === undefined) throw new Error(`workspace ${workspace} on ${host} has no pane`);
    return pane;
  }
  const path = field(tree, "path") ?? `${plan.clone}.worktrees/${plan.session}`;
  if (tree === undefined) {
    await onHost(host, ["sh", "-c", ADD_WORKTREE, "add", plan.clone, path, plan.branch, plan.base]);
  }
  return openWorkerWorkspace(host, path, plan);
}

/** How long a pane's shell may take to settle at its prompt, and herdr to take the start. */
const SHELL_WAIT_MS = 20_000;

/**
 * How long herdr waits for Pi to look ready. herdr counts an agent as ready when it idles, and a
 * worker starts on its task at once, so herdr's wait often runs out. Dispatch does not rely on it:
 * the pane shows whether Pi started. herdr's minimum is just above 3 s.
 */
const READY_WAIT_MS = 4000;

/** How long a Pi that herdr launched may take to show in the pane under its own name. */
const PI_NAME_WAIT_MS = 10_000;

/** herdr's command can be lost before it reaches the shell. It is sent this many times at most. */
const LAUNCH_TRIES = 2;

const toError = (failure: unknown): Error =>
  failure instanceof Error ? failure : new Error(String(failure));

/**
 * herdr refused the start and typed nothing: the shell was not at its prompt yet, or herdr still
 * held the agent name of a worker that died a moment ago.
 */
const refused = (error: Error): boolean =>
  /"code":"agent_(pane_busy|name_taken)"/.test(error.message);

/** How often the pane is looked at. */
const POLL_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Checks until the check holds or the wait ends. */
async function until(check: () => Promise<boolean>, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (!(await check())) {
    if (Date.now() > deadline) return false;
    await sleep(POLL_MS);
  }
  return true;
}

/**
 * Runs herdr's agent start once the pane's shell is idle. Resolves with herdr's error, if any,
 * and as soon as a Pi shows in the pane, because herdr's own readiness wait can run to its end
 * on a worker that is busy at once.
 */
async function launchOnce(host: string, pane: string, args: string[]): Promise<Error | undefined> {
  // A new shell first runs its prompt's helpers, such as git, and keys typed then can be lost.
  const launched = until(() => shellIdle(host, pane), SHELL_WAIT_MS)
    .then(() => herdr(host, args))
    .then(() => undefined, toError);
  const watch = { over: false };
  const appeared = (async (): Promise<undefined> => {
    // A pane that cannot be read is left to herdr's own answer.
    while (!watch.over && !(await piRunning(host, pane).catch(() => false))) await sleep(POLL_MS);
    return undefined;
  })();
  try {
    return await Promise.race([launched, appeared]);
  } finally {
    watch.over = true;
  }
}

/**
 * Starts Pi in the pane. herdr types the command into the shell and waits for Pi to idle, which a
 * worker busy on its task may never do, so Pi in the pane decides. A start that herdr refused goes
 * again at once, until herdr takes it. A command that reached no shell started nothing, and goes
 * once more. herdr refuses a pane where Pi runs, so no second Pi starts.
 */
async function startAgent(host: string, pane: string, args: string[]): Promise<void> {
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
  request: { card: number; host: string; task: string; replace: boolean },
): Promise<string> {
  const plan = parsePlan(await link.call("attempt.begin", request));
  const where = `${plan.session} on ${request.host}`;
  const pane = await worktreePane(request.host, plan);
  // Pi in the worker's pane is the truth: cardd may not have seen the worker die yet.
  if (await piRunning(request.host, pane)) {
    return plan.connected
      ? `c-${String(request.card)} is already running as ${where}.`
      : `Found ${where} already starting.`;
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
        String(READY_WAIT_MS),
        "--",
      ],
      fleetArgs({ url: launch.url, token: plan.token, role: "worker" }),
      ["--session-id", plan.session, ...launch.piArgs],
    ].flat(),
  );
  if (!plan.active) return `Dispatched ${where}, branch ${plan.branch}.`;
  // A relaunch: the worker resumes its own session file. A note starts its next run.
  const note = "Your session was restarted. Continue your task from where you stopped.";
  await link.call("comment", { card: request.card, text: note });
  return `Restarted ${where} on its own session, branch ${plan.branch}.`;
}

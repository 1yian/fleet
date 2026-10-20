// dispatch (spec section 11.2). cardd creates or finds the attempt. Then each
// host step first looks for its own result by the names that derive from the
// attempt ID, so a retry after a lost connection never starts a second worker.
import { check, OPS } from "@fleet/protocol";
import { field, herdr, onHost, piRunning, records, worktreeOf } from "./host.ts";
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

const SHELL_WAIT_MS = 20_000;

/**
 * How long herdr waits for Pi to look ready. herdr counts an agent as ready when it idles, and a
 * worker starts on its task at once, so herdr's wait often runs out. Dispatch does not rely on it:
 * the pane shows whether Pi started. herdr's minimum is just above 3 s.
 */
const READY_WAIT_MS = 4000;

/** How long a Pi that herdr launched may take to show in the pane under its own name. */
const PI_NAME_WAIT_MS = 10_000;

/** Whether Pi runs in the pane, waiting briefly for a Pi that is still starting. */
async function piStarted(host: string, pane: string): Promise<boolean> {
  const deadline = Date.now() + PI_NAME_WAIT_MS;
  while (!(await piRunning(host, pane))) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return true;
}

/** Starts the agent once the new pane's shell reaches its prompt. herdr refuses a pane that is not yet a shell. */
async function startAgent(host: string, pane: string, args: string[]): Promise<void> {
  const deadline = Date.now() + SHELL_WAIT_MS;
  for (;;) {
    const error = await herdr(host, args).then(
      () => undefined,
      (failure: unknown) => (failure instanceof Error ? failure : new Error(String(failure))),
    );
    if (error === undefined) return;
    const shellNotReady =
      error instanceof Error && error.message.includes("not an available shell");
    if (shellNotReady && Date.now() <= deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    // herdr stopped waiting for Pi to idle. Pi in the pane's foreground means it started.
    if (!shellNotReady && (await piStarted(host, pane))) return;
    throw error;
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
  const fleetArgs = [
    "--fleet-url",
    launch.url,
    "--fleet-token",
    plan.token,
    "--fleet-role",
    "worker",
  ];
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
      [...fleetArgs, "--session-id", plan.session, ...launch.piArgs],
    ].flat(),
  );
  if (!plan.active) return `Dispatched ${where}, branch ${plan.branch}.`;
  // A relaunch: the worker resumes its own session file. A note starts its next run.
  const note = "Your session was restarted. Continue your task from where you stopped.";
  await link.call("comment", { card: request.card, text: note });
  return `Restarted ${where} on its own session, branch ${plan.branch}.`;
}

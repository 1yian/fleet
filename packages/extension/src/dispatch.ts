// dispatch (spec section 11.2). cardd creates or finds the attempt. Then each
// host step first looks for its own result by the names that derive from the
// attempt ID, so a retry after a lost connection never starts a second worker.
import { check, OPS } from "@fleet/protocol";
import { field, herdr, onHost, records, worktreeOf } from "./host.ts";
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

async function agentLive(host: string, name: string): Promise<boolean> {
  const agents = records((await herdr(host, ["agent", "list"]))["agents"]);
  return agents.some((agent) => field(agent, "name") === name);
}

const SHELL_WAIT_MS = 20_000;

/** Starts the agent once the new pane's shell reaches its prompt. herdr refuses a pane that is not yet a shell. */
/**
 * How long herdr waits for Pi to become ready. A Pi with many packages can take more than herdr's
 * default 30 s. It stays below the 120 s limit on each herdr call, so herdr reports its own timeout.
 */
const START_WAIT_MS = 90_000;

async function startAgent(host: string, args: string[]): Promise<void> {
  const deadline = Date.now() + SHELL_WAIT_MS;
  for (;;) {
    try {
      await herdr(host, args);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // herdr started Pi but stopped waiting for it: the worker still comes up and connects.
      if (message.includes("timed out waiting for agent startup")) return;
      const busy = message.includes("not an available shell");
      if (!busy || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export async function dispatch(
  link: Link,
  launch: Launch,
  request: { card: number; host: string; task: string; replace: boolean },
): Promise<string> {
  const plan = parsePlan(await link.call("attempt.begin", request));
  const where = `${plan.session} on ${request.host}`;
  // herdr knows whether the worker's Pi is still in its pane; cardd may not have seen it die yet.
  const live = await agentLive(request.host, plan.session);
  if (live && plan.connected) return `c-${String(request.card)} is already running as ${where}.`;
  if (live) return `Found ${where} already starting.`;
  const pane = await worktreePane(request.host, plan);
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
        String(START_WAIT_MS),
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

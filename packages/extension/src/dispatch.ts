// dispatch (spec section 11.2). cardd creates or finds the attempt. Then each
// host step first looks for its own result by the names that derive from the
// attempt ID, so a retry after a lost connection never starts a second worker.
import { check, OPS } from "@fleet/protocol";
import { field, herdr, isRecord, records } from "./host.ts";
import type { Link } from "./link.ts";

export interface Launch {
  /** The cardd websocket URL that workers on other hosts can reach. */
  readonly url: string;
  /** Extra Pi arguments for workers, such as a model profile. */
  readonly piArgs: readonly string[];
}

type Plan = ReturnType<typeof parsePlan>;
const parsePlan = (value: unknown) => check(OPS["attempt.begin"].result, value);

/** The root pane of the attempt's worktree workspace, created if needed. */
async function worktreePane(host: string, plan: Plan): Promise<string> {
  const listed = await herdr(host, ["worktree", "list", "--cwd", plan.clone]);
  const existing = records(listed["worktrees"]).find(
    (tree) => field(tree, "branch") === plan.branch,
  );
  const workspace = field(existing, "open_workspace_id");
  if (existing !== undefined && workspace === undefined) {
    const path = field(existing, "path") ?? "";
    const opened = await herdr(host, [
      "worktree",
      "open",
      "--cwd",
      plan.clone,
      "--path",
      path,
      "--no-focus",
    ]);
    return rootPane(opened);
  }
  if (workspace !== undefined) {
    const panes = records((await herdr(host, ["pane", "list", "--workspace", workspace]))["panes"]);
    const pane = field(panes[0], "pane_id");
    if (pane === undefined) throw new Error(`workspace ${workspace} on ${host} has no pane`);
    return pane;
  }
  const created = await herdr(
    host,
    [
      ["worktree", "create", "--cwd", plan.clone, "--branch", plan.branch, "--base", plan.base],
      ["--path", `${plan.clone}.worktrees/${plan.session}`, "--label", plan.session, "--no-focus"],
    ].flat(),
  );
  return rootPane(created);
}

function rootPane(result: Record<string, unknown>): string {
  const pane = isRecord(result["root_pane"]) ? field(result["root_pane"], "pane_id") : undefined;
  if (pane === undefined) throw new Error("herdr did not return the worktree's pane");
  return pane;
}

async function agentLive(host: string, name: string): Promise<boolean> {
  const agents = records((await herdr(host, ["agent", "list"]))["agents"]);
  return agents.some((agent) => field(agent, "name") === name);
}

const SHELL_WAIT_MS = 20_000;

/** Starts the agent once the new pane's shell reaches its prompt. herdr refuses a pane that is not yet a shell. */
async function startAgent(host: string, args: string[]): Promise<void> {
  const deadline = Date.now() + SHELL_WAIT_MS;
  for (;;) {
    try {
      await herdr(host, args);
      return;
    } catch (error) {
      const busy = error instanceof Error && error.message.includes("not an available shell");
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
  if (plan.active) return `c-${String(request.card)} is already running as ${where}.`;
  const pane = await worktreePane(request.host, plan);
  if (await agentLive(request.host, plan.session)) return `Found ${where} already starting.`;
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
      ["agent", "start", plan.session, "--kind", "pi", "--pane", pane, "--"],
      [...fleetArgs, "--session-id", plan.session, ...launch.piArgs],
    ].flat(),
  );
  return `Dispatched ${where}, branch ${plan.branch}${plan.resumed ? " (resumed the earlier attempt)" : ""}.`;
}

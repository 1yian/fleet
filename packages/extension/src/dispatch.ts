import { check, OPS } from "@fleet/protocol";
import { fleetArgs } from "./fleet-args.ts";
import { field, herdr, onHost, piRunning, records, shellIdle, worktreeOf } from "./host.ts";
import { openWorkerWorkspace } from "./place.ts";
import type { Link } from "./link.ts";

export interface Launch {
  readonly url: string;
  readonly piArgs: readonly string[];
}

type Plan = ReturnType<typeof parsePlan>;
const parsePlan = (value: unknown) => check(OPS["attempt.begin"].result, value);

const ADD_WORKTREE = `set -eu
clone=$1 path=$2 branch=$3 base=$4
if git -C "$clone" show-ref --verify -q "refs/heads/$branch"; then
  git -C "$clone" worktree add -q "$path" "$branch"
else
  git -C "$clone" worktree add -q -b "$branch" "$path" "$base"
fi`;

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
        String(HERDR_READY_WAIT_MS),
        "--",
      ],
      fleetArgs({ url: launch.url, token: plan.token, role: "worker" }),
      ["--session-id", plan.session, ...launch.piArgs],
    ].flat(),
  );
  if (!plan.active) return `Dispatched ${where}, branch ${plan.branch}.`;
  const note = "Your session was restarted. Continue your task from where you stopped.";
  await link.call("comment", { card: request.card, text: note });
  return `Restarted ${where} on its own session, branch ${plan.branch}.`;
}

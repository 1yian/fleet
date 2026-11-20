import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Next, OpArgs, OpResult } from "@fleet/protocol";
import { releaseAll, SERVICE_SCRIPT } from "./containment.ts";
import { refreshClonesInTurn } from "./clones.ts";
import {
  field,
  HELPER_MARK,
  herdr,
  HostUnreachable,
  onHelper,
  SCAN_TIMEOUT_MS,
  TimedOut,
  worktreeOf,
} from "./host.ts";
import type { Link } from "./link.ts";

const ARCHIVE_SCRIPT = readFileSync(
  fileURLToPath(new URL("./archive.sh", import.meta.url)),
  "utf8",
);

const STOP_PROCS_SCRIPT = [
  `helper_mark=${HELPER_MARK}`,
  SERVICE_SCRIPT,
  readFileSync(fileURLToPath(new URL("./stop-procs.sh", import.meta.url)), "utf8"),
].join("\n");

type Attempt = OpResult<"close.begin">["attempts"][number];

const DEADLINE_MS = Number(process.env["FLEET_CLOSE_DEADLINE_MS"]) || 600_000;

const STEPS = [
  "check what is unlanded",
  "land the branch locally",
  "stop the worker's processes",
  "archive unlanded work",
  "remove the worktree",
  "delete the task branch",
  "record the close",
] as const;

class CloseStalled extends Error {}

interface Budget {
  readonly card: number;
  readonly end: number;
}

const seconds = (ms: number): string => `${String(Math.max(1, Math.round(ms / 1000)))} s`;

function stepsOf({ card, end }: Budget, { session, host }: Attempt) {
  return async <T>(
    name: (typeof STEPS)[number],
    work: (timeout: number) => Promise<T>,
    cap = Infinity,
  ): Promise<T> => {
    const remaining = end - Date.now();
    const stalled = (why: string, error?: unknown): CloseStalled =>
      new CloseStalled(
        `c-${String(card)} was not closed. Step "${name}" for ${session} on ${host} ${why}, so close stopped there. Not done: ${STEPS.slice(STEPS.indexOf(name)).join(", ")}. c-${String(card)} stays open: close it again when ${host} answers.`,
        { cause: error },
      );
    const overall = `ran past close's overall limit of ${seconds(DEADLINE_MS)}`;
    if (remaining <= 0) throw stalled(overall);
    try {
      return await work(Math.min(cap, remaining));
    } catch (error) {
      if (!(error instanceof TimedOut)) throw error;
      throw stalled(cap < remaining ? `did not finish within ${seconds(cap)}` : overall, error);
    }
  };
}

const ORIGIN_BASE_IF_FETCHED = `origin=""
if git -C "$clone" rev-parse -q --verify "refs/remotes/origin/$base" >/dev/null; then
  origin="origin/$base"
fi`;

const DELETE_ARCHIVED_BRANCH_SCRIPT = `set -eu
clone=$1 branch=$2 base=$3 out=$4
${ORIGIN_BASE_IF_FETCHED}
status=0
git -C "$clone" show-ref --verify -q "refs/heads/$branch" || status=$?
if [ "$status" -eq 0 ]; then
  drop=0
  if [ -f "$out" ]; then
    drop=1
  else
    ahead=$(git -C "$clone" rev-list --count "refs/heads/$branch" --not "$base" \${origin:+"$origin"})
    if [ "$ahead" -eq 0 ]; then drop=1; fi
  fi
  if [ "$drop" -eq 1 ]; then git -C "$clone" branch -D "$branch" >/dev/null; fi
elif [ "$status" -ne 1 ]; then
  exit "$status"
fi
if [ -f "$out" ]; then echo "$out"; fi`;

const UNLANDED_COUNTS_SCRIPT = `set -eu
wt=$1 clone=$2 branch=$3 base=$4
${ORIGIN_BASE_IF_FETCHED}
ahead=0 dirty=0 commits="" files=""
if [ -d "$wt" ]; then
  ahead=$(git -C "$wt" rev-list --count HEAD --not "$base" \${origin:+"$origin"})
  commits=$(git -C "$wt" log --oneline -n 10 HEAD --not "$base" \${origin:+"$origin"})
  files=$(git -C "$wt" status --porcelain | head -n 20)
  dirty=$(git -C "$wt" status --porcelain | wc -l | tr -d ' ')
elif git -C "$clone" show-ref --verify -q "refs/heads/$branch"; then
  ahead=$(git -C "$clone" rev-list --count "refs/heads/$branch" --not "$base" \${origin:+"$origin"})
  commits=$(git -C "$clone" log --oneline -n 10 "refs/heads/$branch" --not "$base" \${origin:+"$origin"})
fi
echo "$ahead $dirty"
if [ -n "$commits" ]; then echo "$commits" | sed 's/^/c /'; fi
if [ -n "$files" ]; then echo "$files" | sed 's/^/f /'; fi`;

const LAND_LOCALLY_SCRIPT = `set -eu
clone=$1 branch=$2 base=$3
current=$(git -C "$clone" symbolic-ref -q --short HEAD) || current=""
if [ "$current" != "$base" ]; then
  echo "$clone is on \${current:-a detached HEAD}, not $base, so $branch cannot land there" >&2
  exit 1
fi
if [ -n "$(git -C "$clone" status --porcelain | head -n 1)" ]; then
  echo "$clone has uncommitted changes, so $branch cannot land there" >&2
  exit 1
fi
if ! git -C "$clone" merge-base --is-ancestor "$base" "$branch"; then
  echo "$branch is not a fast-forward of $base: have the worker rebase it onto $base" >&2
  exit 1
fi
before=$(git -C "$clone" rev-parse --short HEAD)
git -C "$clone" merge -q --ff-only "$branch"
echo "$before..$(git -C "$clone" rev-parse --short HEAD)"`;

async function dirtyWork(plan: OpResult<"close.begin">, budget: Budget): Promise<string[]> {
  const dirty: string[] = [];
  for (const attempt of plan.attempts) {
    try {
      const { dirty: files } = await unlandedCounts(attempt, budget);
      if (files > 0)
        dirty.push(
          `${attempt.session} on ${attempt.host} has ${describe({ ahead: 0, dirty: files }, attempt.base)}`,
        );
    } catch (error) {
      if (attempt.live || !(error instanceof HostUnreachable)) throw error;
    }
  }
  return dirty;
}

async function landLocally(
  card: number,
  plan: OpResult<"close.begin">,
  budget: Budget,
): Promise<string> {
  const dirty = await dirtyWork(plan, budget);
  if (dirty.length > 0)
    throw new Error(
      `c-${String(card)} cannot land: ${dirty.join("; ")}. Have the worker commit or remove them, then close it again.`,
    );
  const newest = plan.attempts.at(-1);
  if (newest === undefined) throw new Error(`c-${String(card)} has no branch to land`);
  const { host, clone, branch, base } = newest;
  try {
    const moved = await stepsOf(budget, newest)("land the branch locally", (timeout) =>
      onHelper(host, ["sh", "-c", LAND_LOCALLY_SCRIPT, "land", clone, branch, base], timeout),
    );
    return `Landed ${branch} on local ${base} on ${host} (${moved.trim()}).`;
  } catch (error) {
    if (error instanceof CloseStalled) throw error;
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`c-${String(card)} did not land: ${why}`, { cause: error });
  }
}

const EMPTY: Unlanded = { ahead: 0, dirty: 0, commits: [], files: [] };

interface Unlanded {
  ahead: number;
  dirty: number;
  commits: string[];
  files: string[];
}

async function unlandedCounts(attempt: Attempt, budget: Budget): Promise<Unlanded> {
  const { host, clone, branch, base, session } = attempt;
  const listed = await herdr(host, ["worktree", "list", "--cwd", clone], !attempt.live);
  const path = field(worktreeOf(listed, session), "path") ?? `${clone}.worktrees/${session}`;
  const out = await stepsOf(budget, attempt)("check what is unlanded", (timeout) =>
    onHelper(
      host,
      ["sh", "-c", UNLANDED_COUNTS_SCRIPT, "landing", path, clone, branch, base],
      timeout,
    ),
  );
  const [counts = "", ...rest] = out.trimEnd().split("\n");
  const [ahead = 0, dirty = 0] = counts.trim().split(" ").map(Number);
  const tagged = (tag: string) =>
    rest.filter((line) => line.startsWith(`${tag} `)).map((line) => line.slice(2));
  return { ahead, dirty, commits: tagged("c"), files: tagged("f") };
}

function describe({ ahead, dirty }: { ahead: number; dirty: number }, base: string): string {
  const parts = [
    ahead > 0 ? `${String(ahead)} commit${ahead === 1 ? "" : "s"} not on ${base}` : "",
    dirty > 0 ? `${String(dirty)} uncommitted file${dirty === 1 ? "" : "s"}` : "",
  ].filter((part) => part !== "");
  return parts.join(" and ");
}

async function inspect(attempt: Attempt, budget: Budget): Promise<Unlanded> {
  try {
    return await unlandedCounts(attempt, budget);
  } catch (error) {
    if (attempt.live || !(error instanceof HostUnreachable)) throw error;
    return EMPTY;
  }
}

async function unlandedWarning(
  card: number,
  plan: OpResult<"close.begin">,
  confirmed: boolean,
  budget: Budget,
): Promise<string | undefined> {
  if (!plan.verify || confirmed) return undefined;
  const left: string[] = [];
  const detail: string[] = [];
  for (const attempt of plan.attempts) {
    const found = await inspect(attempt, budget);
    const what = describe(found, attempt.base);
    if (what === "") continue;
    left.push(`${attempt.session} on ${attempt.host} has ${what}`);
    for (const commit of found.commits) detail.push(`  commit ${attempt.session}: ${commit}`);
    for (const file of found.files) detail.push(`  file ${attempt.session}: ${file}`);
  }
  if (left.length === 0) return undefined;
  return `c-${String(card)} was not closed. ${left.join("; ")}:\n${detail.join("\n")}\nIf this work landed elsewhere (another card's branch or PR), call close again with confirm=true: the card ends Done and this work is archived first. If it did not land and should not end Done, land it, or end it with close(card, summary=<why it is dropped>, landed=false).`;
}

interface Retired {
  archive: string | null;
  stopped: string[];
  spared: string[];
}

function processesOf(session: string, out: string): { stopped: string[]; spared: string[] } {
  const stopped: string[] = [];
  const spared: string[] = [];
  for (const line of out.split("\n").filter((each) => each !== "")) {
    const [pid = "", how = "", ...command] = line.split("\t");
    const named = `${session} pid ${pid} (${command.join(" ").trim()})`;
    if (how === "ADOPTED") spared.push(named);
    else
      stopped.push(
        `${named} ${how === "TERM" ? "stopped by TERM" : how === "KILL" ? "needed KILL" : "still running"}`,
      );
  }
  return { stopped, spared };
}

async function retire(attempt: Attempt, budget: Budget): Promise<Retired> {
  const { host, clone, branch, base, session } = attempt;
  const step = stepsOf(budget, attempt);
  const archiveDir = `${clone}.archive`;
  const listed = await herdr(host, ["worktree", "list", "--cwd", clone], !attempt.live);
  const tree = worktreeOf(listed, session);
  const own = field(tree, "branch");
  const drop = own === undefined || own === branch ? [branch] : [branch, own];
  let processes: { stopped: string[]; spared: string[] } = { stopped: [], spared: [] };
  if (tree !== undefined) {
    const workspace = field(tree, "open_workspace_id");
    if (workspace !== undefined) await herdr(host, ["workspace", "close", workspace]);
    const path = field(tree, "path") ?? "";
    const stopStep = "stop the worker's processes";
    const found = await step(
      stopStep,
      (timeout) => onHelper(host, ["sh", "-c", STOP_PROCS_SCRIPT, "stop", path], timeout),
      SCAN_TIMEOUT_MS,
    );
    const released = await step(
      stopStep,
      (timeout) => releaseAll(host, path, timeout),
      SCAN_TIMEOUT_MS,
    );
    processes = processesOf(session, found + released);
    await step("archive unlanded work", (timeout) =>
      onHelper(
        host,
        ["sh", "-c", ARCHIVE_SCRIPT, "archive", path, base, archiveDir, session],
        timeout,
      ),
    );
    await step("remove the worktree", (timeout) =>
      onHelper(host, ["git", "-C", clone, "worktree", "remove", "--force", path], timeout),
    );
  }
  const out = `${archiveDir}/${session}.tar.zst`;
  let archive = "";
  for (const each of drop) {
    const dropped = await step("delete the task branch", (timeout) =>
      onHelper(
        host,
        ["sh", "-c", DELETE_ARCHIVED_BRANCH_SCRIPT, "finish", clone, each, base, out],
        timeout,
      ),
    );
    archive = dropped.trim();
  }
  return { archive: archive === "" ? null : archive, ...processes };
}

interface CloseRequest {
  card: number;
  text: string;
  landed?: boolean | undefined;
  confirm?: boolean | undefined;
  next?: Next | undefined;
  onClosed?: (() => void) | undefined;
}

interface Running {
  readonly landed: boolean | undefined;
  readonly confirm: boolean;
  readonly next: string | undefined;
  readonly outcome: Promise<string>;
}

const running = new Map<number, Running>();

const settled = (work: Promise<unknown>): Promise<void> =>
  work.then(
    () => undefined,
    () => undefined,
  );

export async function close(link: Link, request: CloseRequest): Promise<string> {
  const { card, landed } = request;
  const confirm = request.confirm === true;
  const next = request.next === undefined ? undefined : JSON.stringify(request.next);
  for (let other = running.get(card); other !== undefined; other = running.get(card)) {
    if (other.landed === landed && other.next === next && (other.confirm || !confirm))
      return other.outcome;
    await settled(other.outcome);
  }
  const outcome = (async () => {
    try {
      return await closeOnce(link, request);
    } finally {
      running.delete(card);
    }
  })();
  running.set(card, { landed, confirm, next, outcome });
  return outcome;
}

const planOf = (link: Link, { card, landed, next }: CloseRequest) =>
  link.call("close.begin", {
    card,
    ...(landed === undefined ? {} : { landed }),
    ...(next === undefined ? {} : { next }),
  });

async function closedMeanwhile(link: Link, request: CloseRequest): Promise<boolean> {
  try {
    await planOf(link, request);
    return false;
  } catch (error) {
    return error instanceof Error && / is already (done|dropped)$/.test(error.message);
  }
}

async function closeOnce(link: Link, request: CloseRequest): Promise<string> {
  const plan = await planOf(link, request);
  try {
    return await teardown(link, request, plan);
  } catch (error) {
    if (await closedMeanwhile(link, request))
      return `c-${String(request.card)} was closed by another close at the same time, so there is nothing left to do.`;
    throw error;
  }
}

async function finishClose(
  link: Link,
  request: CloseRequest,
  finish: OpArgs<"close.finish">,
): Promise<OpResult<"close.finish">> {
  const card = await link.call("close.finish", finish);
  request.onClosed?.();
  return card;
}

async function teardown(
  link: Link,
  request: CloseRequest,
  plan: OpResult<"close.begin">,
): Promise<string> {
  const { card: id, text, confirm, next } = request;
  const budget = { card: id, end: Date.now() + DEADLINE_MS };
  const moved = plan.land ? await landLocally(id, plan, budget) : "";
  const warning = await unlandedWarning(id, plan, confirm === true, budget);
  if (warning !== undefined) return warning;
  const archives: string[] = [];
  const stopped: string[] = [];
  const spared: string[] = [];
  const left: { session: string; host: string; reason: string }[] = [];
  for (const attempt of plan.attempts) {
    try {
      const retired = await retire(attempt, budget);
      if (retired.archive !== null) archives.push(`${attempt.host}:${retired.archive}`);
      stopped.push(...retired.stopped);
      spared.push(...retired.spared);
    } catch (error) {
      if (attempt.live || !(error instanceof HostUnreachable)) throw error;
      left.push({ session: attempt.session, host: attempt.host, reason: error.message });
    }
  }
  const finish = {
    card: id,
    mode: plan.mode,
    text,
    ...(next === undefined ? {} : { next }),
    archives,
    left,
  };
  const card = await finishClose(link, request, finish);
  const hostsJustUnreachable = new Set(left.map((each) => each.host));
  const found = await refreshClonesInTurn(
    plan.refresh.filter((each) => !hostsJustUnreachable.has(each.host)),
  );
  const landing = moved === "" ? "" : ` ${moved}`;
  return `c-${String(card.id)} is ${card.status}.${landing}${outcome(archives, left, found, { stopped, spared })}`;
}

function outcome(
  archives: readonly string[],
  left: readonly { session: string; host: string; reason: string }[],
  clones: readonly string[],
  { stopped, spared }: { stopped: readonly string[]; spared: readonly string[] },
): string {
  const ended = stopped.length === 0 ? "" : ` Stopped leftover processes: ${stopped.join("; ")}.`;
  const shared = spared.length === 0 ? "" : ` Kept shared services: ${spared.join("; ")}.`;
  const kept = archives.length === 0 ? "" : ` Unlanded work is archived in ${archives.join(", ")}.`;
  const stayed =
    left.length === 0
      ? ""
      : ` Left in place: ${left.map((each) => `${each.host} ${each.session} (${each.reason})`).join("; ")}.`;
  const found = clones.length === 0 ? "" : ` Clones: ${clones.join("; ")}.`;
  return `${ended}${shared}${kept}${stayed}${found}`;
}

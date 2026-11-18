import { evidenceScope, type OpResult } from "@fleet/protocol";
import { field, herdr, HostUnreachable, onHelper, worktreeOf } from "./host.ts";
import { checkEvidenceCommand } from "./scratch.ts";

export type Attempt = OpResult<"close.begin">["attempts"][number];
type Plan = OpResult<"close.begin">;

export interface Processes {
  stopped: string[];
  spared: string[];
}

export type StopWriters = (
  attempt: Attempt,
  tree: Record<string, unknown>,
  path: string,
) => Promise<Processes>;

export function describe({ ahead, dirty }: { ahead: number; dirty: number }, base: string): string {
  const parts = [
    ahead > 0 ? `${String(ahead)} commit${ahead === 1 ? "" : "s"} not on ${base}` : "",
    dirty > 0 ? `${String(dirty)} changed, untracked or ignored file${dirty === 1 ? "" : "s"}` : "",
  ].filter((part) => part !== "");
  return parts.join(" and ");
}

const TREE_SCRIPT = `set -eu
wt=$1 clone=$2 base=$3 branch=$4
[ -d "$wt" ] || { echo "no worktree at $wt" >&2; exit 1; }
real=$(cd "$wt" && pwd -P)
top=$(git -C "$wt" rev-parse --show-toplevel)
[ "$top" = "$real" ] || { echo "$wt is not a worktree root" >&2; exit 1; }
git -C "$clone" rev-parse --verify -q "refs/heads/$base^{commit}" >/dev/null
head=$(git -C "$wt" rev-parse HEAD)
refs=HEAD
cur=$(git -C "$wt" symbolic-ref -q HEAD || true)
for ref in "$cur" "refs/heads/$branch"; do
  if [ -n "$ref" ] && git -C "$wt" show-ref --verify -q "$ref"; then refs="$refs $ref"; fi
done
ahead=$(git -C "$wt" rev-list --count $refs --not "refs/heads/$base")
commits=$(git -C "$wt" log --oneline -n 10 $refs --not "refs/heads/$base")
files=$(git -C "$wt" status --porcelain --untracked-files=all --ignored)
dirty=$(printf '%s' "$files" | grep -c '' || true)
echo "$head $ahead $dirty"
if [ -n "$commits" ]; then printf '%s\\n' "$commits" | sed 's/^/c /'; fi
if [ -n "$files" ]; then printf '%s\\n' "$files" | head -n 20 | sed 's/^/f /'; fi`;

const RETIRE_SCRIPT = `set -eu
wt=$1 clone=$2 base=$3
shift 3
git -C "$clone" worktree remove "$wt"
for branch in "$@"; do
  if git -C "$clone" show-ref --verify -q "refs/heads/$branch"; then
    ahead=$(git -C "$clone" rev-list --count "refs/heads/$branch" --not "refs/heads/$base")
    [ "$ahead" -eq 0 ] || { echo "$branch is ahead of $base" >&2; exit 1; }
    git -C "$clone" branch -D "$branch" >/dev/null
  fi
done
[ ! -e "$wt" ]
for branch in "$@"; do
  if git -C "$clone" show-ref --verify -q "refs/heads/$branch"; then exit 1; fi
done`;

interface Tree {
  readonly ahead: number;
  readonly dirty: number;
  readonly commits: string[];
  readonly files: string[];
}

function parseTree(output: string): Tree {
  const [counts = "", ...rest] = output.trimEnd().split("\n");
  const [head = "", ahead = "", dirty = ""] = counts.trim().split(" ");
  if (head === "" || !/^\d+$/.test(ahead) || !/^\d+$/.test(dirty))
    throw new Error("the worktree check printed nothing usable");
  const tagged = (tag: string): string[] =>
    rest.filter((line) => line.startsWith(`${tag} `)).map((line) => line.slice(2));
  return { ahead: Number(ahead), dirty: Number(dirty), commits: tagged("c"), files: tagged("f") };
}

async function requireEvidence(card: number, evidence: string, attempt: Attempt): Promise<void> {
  try {
    await onHelper(attempt.host, checkEvidenceCommand(card, evidence));
  } catch (error) {
    if (error instanceof HostUnreachable) throw error;
    throw new Error(
      `c-${String(card)} cannot close Done: its ops evidence is not a regular report file in the card's scratch folder on ${attempt.host}. Have the worker fix its handoff, or close with landed=false`,
      { cause: error },
    );
  }
}

async function requireClean(card: number, attempt: Attempt, path: string): Promise<void> {
  const { host, session, clone, base, branch } = attempt;
  let found;
  try {
    found = parseTree(
      await onHelper(host, ["sh", "-c", TREE_SCRIPT, "tree", path, clone, base, branch]),
    );
  } catch (error) {
    if (error instanceof HostUnreachable) throw error;
    throw new Error(
      `c-${String(card)} was not closed. ${session} on ${host} could not be checked against local ${base}, so nothing was removed. Close with landed=false and a reason to archive it as Dropped`,
      { cause: error },
    );
  }
  const what = describe(found, base);
  if (what === "") return;
  const detail = [
    ...found.commits.map((commit) => `  commit ${session}: ${commit}`),
    ...found.files.map((file) => `  file ${session}: ${file}`),
  ];
  throw new Error(
    `c-${String(card)} was not closed. ${session} on ${host} has ${what}, left in place:\n${detail.join("\n")}\nAn ops card cannot end Done with unexpected code changes, even with confirm=true. Dispatch product changes separately, or close with landed=false and a reason to archive them as Dropped.`,
  );
}

function sameBinding(before: Plan, now: Plan): boolean {
  const names = (plan: Plan): string => plan.attempts.map((each) => each.session).join(",");
  return (
    before.operation?.handoff === now.operation?.handoff &&
    before.operation?.evidence === now.operation?.evidence &&
    names(before) === names(now)
  );
}

export async function verifyOperation(
  card: number,
  plan: Plan,
  stop: StopWriters,
  replan: () => Promise<Plan>,
): Promise<Map<string, Processes>> {
  const { operation } = plan;
  const stopped = new Map<string, Processes>();
  if (operation === undefined) return stopped;
  const holder = plan.attempts.find((each) => each.session === operation.session);
  if (holder === undefined)
    throw new Error(
      `c-${String(card)} cannot close Done: its ops evidence has no attempt to read it on`,
    );
  await requireEvidence(card, operation.evidence, holder);
  for (const attempt of plan.attempts) {
    const listed = await herdr(
      attempt.host,
      ["worktree", "list", "--cwd", attempt.clone],
      !attempt.live,
    );
    const tree = worktreeOf(listed, attempt.session);
    const path = field(tree, "path");
    if (tree === undefined || path === undefined)
      throw new Error(
        `c-${String(card)} was not closed. ${attempt.session} has no registered worktree on ${attempt.host} to check, so nothing was removed. Close with landed=false and a reason to archive it as Dropped`,
      );
    stopped.set(attempt.session, await stop(attempt, tree, path));
    await requireClean(card, attempt, path);
  }
  await requireEvidence(card, operation.evidence, holder);
  if (!sameBinding(plan, await replan()))
    throw new Error(
      `c-${String(card)} was not closed. The worker's handoff or the card's attempts changed while close was checking them, so nothing was removed. Close it again`,
    );
  return stopped;
}

export async function retireOperation(
  attempt: Attempt,
  path: string,
  branches: readonly string[],
): Promise<void> {
  await onHelper(attempt.host, [
    "sh",
    "-c",
    RETIRE_SCRIPT,
    "retire",
    path,
    attempt.clone,
    attempt.base,
    ...branches,
  ]);
}

export function retainedEvidence(
  card: number,
  plan: OpResult<"close.begin">,
): string {
  const { operation } = plan;
  const host = plan.attempts.find((each) => each.session === operation?.session)?.host;
  const scope = operation === undefined ? undefined : evidenceScope(card, operation.evidence);
  if (operation === undefined || host === undefined || scope === undefined) return "";
  return ` Evidence kept at ${host}:${scope.folder}/${scope.rel}.`;
}

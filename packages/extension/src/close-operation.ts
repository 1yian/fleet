import {
  evidenceScope,
  OPERATION_TREE_SCRIPT,
  parseOperationTree,
  type OpResult,
} from "@fleet/protocol";
import type { Link } from "./link.ts";
import { field, herdr, HostUnreachable, onHelper, worktreeOf } from "./host.ts";

export type Attempt = OpResult<"close.begin">["attempts"][number];
type Plan = OpResult<"close.begin">;

export interface Processes {
  stopped: string[];
  spared: string[];
  alive: string[];
}

export type StopWriters = (
  attempt: Attempt,
  tree: Record<string, unknown>,
  path: string,
) => Promise<Processes>;

interface Placed {
  readonly path: string;
  readonly processes: Processes;
}

export function describe({ ahead, dirty }: { ahead: number; dirty: number }, base: string): string {
  const parts = [
    ahead > 0 ? `${String(ahead)} commit${ahead === 1 ? "" : "s"} not on ${base}` : "",
    dirty > 0 ? `${String(dirty)} changed, untracked or ignored file${dirty === 1 ? "" : "s"}` : "",
  ].filter((part) => part !== "");
  return parts.join(" and ");
}

const ARCHIVE_COVERS_SCRIPT = `set -eu
wt=$1 base=$2 branch=$3 out=$4
if git -C "$wt" show-ref --verify -q "refs/heads/$branch"; then
  extra=$(git -C "$wt" rev-list --count "refs/heads/$branch" --not HEAD "refs/heads/$base")
  if [ "$extra" -gt 0 ]; then echo "commits on branch $branch that the archive would not hold"; fi
fi
if git -C "$wt" show-ref --verify -q "refs/remotes/origin/$base"; then
  all=$(git -C "$wt" rev-list --count HEAD --not "refs/heads/$base")
  held=$(git -C "$wt" rev-list --count HEAD --not "refs/heads/$base" "refs/remotes/origin/$base")
  if [ "$all" -ne "$held" ]; then echo "commits that only origin's cached base holds, which the archive leaves out"; fi
fi
ignored=$(git -C "$wt" status --porcelain --ignored | grep -c '^!!' || true)
if [ "$ignored" -gt 0 ]; then echo "$ignored ignored files that the archive would not hold"; fi
if [ -f "$out" ]; then
  ahead=$(git -C "$wt" rev-list --count HEAD --not "refs/heads/$base")
  changed=$(git -C "$wt" status --porcelain | grep -c '' || true)
  if [ "$ahead" -gt 0 ] || [ "$changed" -gt 0 ]; then
    echo "an archive already exists, so the current work would not be saved in it"
  fi
fi`;

const ORPHAN_REF_SCRIPT = `set -eu
clone=$1 base=$2 branch=$3
if git -C "$clone" show-ref --verify -q "refs/heads/$branch"; then
  ahead=$(git -C "$clone" rev-list --count "refs/heads/$branch" --not "refs/heads/$base")
  if [ "$ahead" -gt 0 ]; then echo "branch $branch with commits and no worktree to archive them from"; fi
fi`;

async function requireClean(card: number, attempt: Attempt, path: string): Promise<void> {
  const { host, session, clone, base, branch } = attempt;
  let found;
  try {
    found = parseOperationTree(
      await onHelper(host, ["sh", "-c", OPERATION_TREE_SCRIPT, "tree", path, clone, base, branch]),
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
    `c-${String(card)} was not closed. ${session} on ${host} has ${what}, left in place:\n${detail.join("\n")}\nAn ops card cannot end Done with unexpected code changes, even with confirm=true. Dispatch product changes separately, or close with landed=false and a reason to archive them as Dropped when the archive can hold them.`,
  );
}

async function stopped(
  card: number,
  attempt: Attempt,
  stop: StopWriters,
): Promise<Placed | undefined> {
  const listed = await herdr(
    attempt.host,
    ["worktree", "list", "--cwd", attempt.clone],
    !attempt.live,
  );
  const tree = worktreeOf(listed, attempt.session);
  const path = field(tree, "path");
  if (tree === undefined || path === undefined) return undefined;
  const processes = await stop(attempt, tree, path);
  if (processes.alive.length > 0)
    throw new Error(
      `c-${String(card)} was not closed. ${attempt.session} still has running processes after the stop: ${processes.alive.join("; ")}. Nothing was removed`,
    );
  return { path, processes };
}

export async function requireArchivable(
  card: number,
  plan: Plan,
  stop: StopWriters,
): Promise<void> {
  for (const attempt of plan.attempts) {
    let found;
    try {
      found = await stopped(card, attempt, stop);
    } catch (error) {
      if (attempt.live || !(error instanceof HostUnreachable)) throw error;
      continue;
    }
    const out = `${attempt.clone}.archive/${attempt.session}.tar.zst`;
    const said = await onHelper(
      attempt.host,
      found === undefined
        ? ["sh", "-c", ORPHAN_REF_SCRIPT, "orphan", attempt.clone, attempt.base, attempt.branch]
        : [
            "sh",
            "-c",
            ARCHIVE_COVERS_SCRIPT,
            "covers",
            found.path,
            attempt.base,
            attempt.branch,
            out,
          ],
    );
    const blocks = said.split("\n").filter((line) => line !== "");
    if (blocks.length > 0)
      throw new Error(
        `c-${String(card)} was not dropped. ${attempt.session} on ${attempt.host} has ${blocks.join("; ")}. Nothing was removed: have the work moved or saved by hand, then close again`,
      );
  }
}

const RETAINED_SCRIPT = '[ -f "$1" ] && [ ! -L "$1" ] && [ -r "$1" ]';

export async function retainedEvidence(
  card: number,
  plan: Plan,
  closed: Readonly<Record<string, string>>,
): Promise<string> {
  const { operation } = plan;
  const host = plan.attempts.find((each) => each.session === operation?.session)?.host;
  const scope = operation === undefined ? undefined : evidenceScope(card, operation.evidence);
  if (operation === undefined || host === undefined || scope === undefined) return "";
  const folder = closed[host];
  const unconfirmed = " Evidence retention not confirmed.";
  if (folder === undefined) return unconfirmed;
  const kept = `${folder}/${scope.rel}`;
  try {
    await onHelper(host, ["sh", "-c", RETAINED_SCRIPT, "retained", kept]);
    return ` Evidence kept at ${host}:${kept}.`;
  } catch {
    return unconfirmed;
  }
}

export async function retireOperationAttempts(
  link: Link,
  id: number,
  plan: Plan,
  stop: StopWriters,
  done: { stopped: string[]; spared: string[]; retiredOn: Set<string> },
): Promise<void> {
  for (const attempt of plan.attempts) {
    const found = await stopped(id, attempt, stop);
    if (found === undefined) continue;
    await requireClean(id, attempt, found.path);
    done.stopped.push(...found.processes.stopped);
    done.spared.push(...found.processes.spared);
  }
  await link.call("close.verify", { card: id, handoff: plan.operation?.handoff ?? 0 });
  for (const attempt of plan.attempts) done.retiredOn.add(attempt.host);
}

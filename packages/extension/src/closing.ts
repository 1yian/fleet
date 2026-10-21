import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { OpResult } from "@fleet/protocol";
import { refreshClonesInTurn } from "./clones.ts";
import { field, herdr, HostUnreachable, onHost, worktreeOf } from "./host.ts";
import type { Link } from "./link.ts";

const ARCHIVE_SCRIPT = readFileSync(
  fileURLToPath(new URL("./archive.sh", import.meta.url)),
  "utf8",
);

type Attempt = OpResult<"close.begin">["attempts"][number];

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
ahead=0 dirty=0
if [ -d "$wt" ]; then
  ahead=$(git -C "$wt" rev-list --count HEAD --not "$base" \${origin:+"$origin"})
  dirty=$(git -C "$wt" status --porcelain | wc -l | tr -d ' ')
elif git -C "$clone" show-ref --verify -q "refs/heads/$branch"; then
  ahead=$(git -C "$clone" rev-list --count "refs/heads/$branch" --not "$base" \${origin:+"$origin"})
fi
echo "$ahead $dirty"`;

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

async function landLocally(card: number, plan: OpResult<"close.begin">): Promise<string> {
  const dirty: string[] = [];
  for (const attempt of plan.attempts) {
    try {
      const { dirty: files } = await unlandedCounts(attempt);
      if (files > 0)
        dirty.push(
          `${attempt.session} on ${attempt.host} has ${describe({ ahead: 0, dirty: files }, attempt.base)}`,
        );
    } catch (error) {
      if (attempt.live || !(error instanceof HostUnreachable)) throw error;
    }
  }
  if (dirty.length > 0)
    throw new Error(
      `c-${String(card)} cannot land: ${dirty.join("; ")}. Have the worker commit or remove them, then close it again.`,
    );
  const newest = plan.attempts.at(-1);
  if (newest === undefined) throw new Error(`c-${String(card)} has no branch to land`);
  const { host, clone, branch, base } = newest;
  try {
    const moved = await onHost(host, [
      "sh",
      "-c",
      LAND_LOCALLY_SCRIPT,
      "land",
      clone,
      branch,
      base,
    ]);
    return `Landed ${branch} on local ${base} on ${host} (${moved.trim()}).`;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`c-${String(card)} did not land: ${why}`, { cause: error });
  }
}

async function unlandedCounts(attempt: Attempt): Promise<{ ahead: number; dirty: number }> {
  const { host, clone, branch, base, session } = attempt;
  const listed = await herdr(host, ["worktree", "list", "--cwd", clone], !attempt.live);
  const path = field(worktreeOf(listed, session), "path") ?? `${clone}.worktrees/${session}`;
  const out = await onHost(host, [
    "sh",
    "-c",
    UNLANDED_COUNTS_SCRIPT,
    "landing",
    path,
    clone,
    branch,
    base,
  ]);
  const [ahead = 0, dirty = 0] = out.trim().split(" ").map(Number);
  return { ahead, dirty };
}

function describe({ ahead, dirty }: { ahead: number; dirty: number }, base: string): string {
  const parts = [
    ahead > 0 ? `${String(ahead)} commit${ahead === 1 ? "" : "s"} not on ${base}` : "",
    dirty > 0 ? `${String(dirty)} uncommitted file${dirty === 1 ? "" : "s"}` : "",
  ].filter((part) => part !== "");
  return parts.join(" and ");
}

async function unlanded(attempt: Attempt): Promise<string> {
  return describe(await unlandedCounts(attempt), attempt.base);
}

async function requireLanded(card: number, plan: OpResult<"close.begin">): Promise<void> {
  const left: string[] = [];
  for (const attempt of plan.attempts) {
    try {
      const what = await unlanded(attempt);
      if (what !== "") left.push(`${attempt.session} on ${attempt.host} has ${what}`);
    } catch (error) {
      if (attempt.live || !(error instanceof HostUnreachable)) throw error;
    }
  }
  if (left.length === 0) return;
  const unlandedWork = left.join("; ");
  const end =
    "end it with close(card, summary=<why it is dropped>, landed=false), which archives it";
  throw new Error(
    plan.noRepoHint === undefined
      ? `c-${String(card)} did not land: ${unlandedWork}. Land it, or ${end}.`
      : `${plan.noRepoHint}. In its clones, ${unlandedWork}. If that work did not merge, land it, or ${end}.`,
  );
}

async function retire(attempt: Attempt): Promise<string | null> {
  const { host, clone, branch, base, session } = attempt;
  const archiveDir = `${clone}.archive`;
  const listed = await herdr(host, ["worktree", "list", "--cwd", clone], !attempt.live);
  const tree = worktreeOf(listed, session);
  const own = field(tree, "branch");
  const drop = own === undefined || own === branch ? [branch] : [branch, own];
  if (tree !== undefined) {
    const workspace = field(tree, "open_workspace_id");
    if (workspace !== undefined) await herdr(host, ["workspace", "close", workspace]);
    const path = field(tree, "path") ?? "";
    await onHost(host, ["sh", "-c", ARCHIVE_SCRIPT, "archive", path, base, archiveDir, session]);
    await onHost(host, ["git", "-C", clone, "worktree", "remove", "--force", path]);
  }
  const out = `${archiveDir}/${session}.tar.zst`;
  let archive = "";
  for (const each of drop) {
    archive = (
      await onHost(host, [
        "sh",
        "-c",
        DELETE_ARCHIVED_BRANCH_SCRIPT,
        "finish",
        clone,
        each,
        base,
        out,
      ])
    ).trim();
  }
  return archive === "" ? null : archive;
}

export async function close(
  link: Link,
  request: { card: number; text: string; landed?: boolean | undefined },
): Promise<string> {
  const { card: id, text, landed } = request;
  const plan = await link.call("close.begin", {
    card: id,
    ...(landed === undefined ? {} : { landed }),
  });
  const moved = plan.land ? await landLocally(id, plan) : "";
  if (plan.verify) await requireLanded(id, plan);
  const archives: string[] = [];
  const left: { session: string; host: string; reason: string }[] = [];
  for (const attempt of plan.attempts) {
    try {
      const path = await retire(attempt);
      if (path !== null) archives.push(`${attempt.host}:${path}`);
    } catch (error) {
      if (attempt.live || !(error instanceof HostUnreachable)) throw error;
      left.push({ session: attempt.session, host: attempt.host, reason: error.message });
    }
  }
  const finish = { card: id, mode: plan.mode, text, archives, left };
  const card = await link.call("close.finish", finish);
  const hostsJustUnreachable = new Set(left.map((each) => each.host));
  const found = await refreshClonesInTurn(
    plan.refresh.filter((each) => !hostsJustUnreachable.has(each.host)),
  );
  const landing = moved === "" ? "" : ` ${moved}`;
  return `c-${String(card.id)} is ${card.status}.${landing}${outcome(archives, left, found)}`;
}

function outcome(
  archives: readonly string[],
  left: readonly { session: string; host: string; reason: string }[],
  clones: readonly string[],
): string {
  const kept = archives.length === 0 ? "" : ` Unlanded work is archived in ${archives.join(", ")}.`;
  const stayed =
    left.length === 0
      ? ""
      : ` Left in place: ${left.map((each) => `${each.host} ${each.session} (${each.reason})`).join("; ")}.`;
  const found = clones.length === 0 ? "" : ` Clones: ${clones.join("; ")}.`;
  return `${kept}${stayed}${found}`;
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CardSchema, check, OPS } from "@fleet/protocol";
import { field, herdr, HostUnreachable, onHost, worktreeOf } from "./host.ts";
import type { Link } from "./link.ts";

const ARCHIVE_SCRIPT = readFileSync(
  fileURLToPath(new URL("./archive.sh", import.meta.url)),
  "utf8",
);

type Attempt = ReturnType<typeof parsePlan>["attempts"][number];
const parsePlan = (value: unknown) => check(OPS["close.begin"].result, value);

const DELETE_ARCHIVED_BRANCH_SCRIPT = `set -eu
clone=$1 branch=$2 base=$3 out=$4
status=0
git -C "$clone" show-ref --verify -q "refs/heads/$branch" || status=$?
if [ "$status" -eq 0 ]; then
  drop=0
  if [ -f "$out" ]; then
    drop=1
  else
    ahead=$(git -C "$clone" rev-list --count "$base..refs/heads/$branch")
    if [ "$ahead" -eq 0 ]; then drop=1; fi
  fi
  if [ "$drop" -eq 1 ]; then git -C "$clone" branch -D "$branch" >/dev/null; fi
elif [ "$status" -ne 1 ]; then
  exit "$status"
fi
if [ -f "$out" ]; then echo "$out"; fi`;

const UNLANDED_COUNTS_SCRIPT = `set -eu
wt=$1 clone=$2 branch=$3 base=$4
ahead=0 dirty=0
if [ -d "$wt" ]; then
  ahead=$(git -C "$wt" rev-list --count "$base..HEAD")
  dirty=$(git -C "$wt" status --porcelain | wc -l | tr -d ' ')
elif git -C "$clone" show-ref --verify -q "refs/heads/$branch"; then
  ahead=$(git -C "$clone" rev-list --count "$base..refs/heads/$branch")
fi
echo "$ahead $dirty"`;

async function unlanded(attempt: Attempt): Promise<string> {
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
  const parts = [
    ahead > 0 ? `${String(ahead)} commit${ahead === 1 ? "" : "s"} not on ${base}` : "",
    dirty > 0 ? `${String(dirty)} uncommitted file${dirty === 1 ? "" : "s"}` : "",
  ].filter((part) => part !== "");
  return parts.join(" and ");
}

async function requireLanded(card: number, plan: ReturnType<typeof parsePlan>): Promise<void> {
  const left: string[] = [];
  for (const attempt of plan.attempts) {
    try {
      const what = await unlanded(attempt);
      if (what !== "") left.push(`${attempt.session} on ${attempt.host} has ${what}`);
    } catch (error) {
      if (attempt.live || !(error instanceof HostUnreachable)) throw error;
    }
  }
  if (left.length > 0) {
    throw new Error(
      `c-${String(card)} did not land: ${left.join("; ")}. Land it, or end it with close(card, summary=<why it is dropped>, landed=false), which archives it.`,
    );
  }
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
  const plan = parsePlan(
    await link.call("close.begin", { card: id, ...(landed === undefined ? {} : { landed }) }),
  );
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
  const card = check(CardSchema, await link.call("close.finish", finish));
  const kept = archives.length === 0 ? "" : ` Unlanded work is archived in ${archives.join(", ")}.`;
  const stayed =
    left.length === 0
      ? ""
      : ` Left in place: ${left.map((each) => `${each.host} ${each.session} (${each.reason})`).join("; ")}.`;
  return `c-${String(card.id)} is ${card.status}.${kept}${stayed}`;
}

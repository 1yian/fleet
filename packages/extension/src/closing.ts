// cleanup and card drop (spec section 20.5), in this order: stop every writer
// (close the worker's herdr workspace, which ends Pi and the job tabs), archive
// and verify all unlanded work, remove the worktree, then close the card. Each
// step finds its own result first, so a rerun converges.
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

// Deletes the task branch once its work is archived or already on the base branch.
// Prints the archive path when the archive exists. Only a missing branch is
// tolerated: every other git failure ends the script with its status. Safe to rerun.
const FINISH_SCRIPT = `set -eu
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

/** Stops the writers, archives, and removes the worktree and branch. Returns the archive path, or null if there is no archive. */
async function retire(attempt: Attempt): Promise<string | null> {
  const { host, clone, branch, base, session } = attempt;
  const archiveDir = `${clone}.archive`;
  const listed = await herdr(host, ["worktree", "list", "--cwd", clone], !attempt.live);
  const tree = worktreeOf(listed, session);
  // The worker may have moved its worktree to its own branch. That branch goes too, after the archive.
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
      await onHost(host, ["sh", "-c", FINISH_SCRIPT, "finish", clone, each, base, out])
    ).trim();
  }
  return archive === "" ? null : archive;
}

export async function close(
  link: Link,
  request: { card: number; mode: "done" | "dropped"; text: string },
): Promise<string> {
  const plan = parsePlan(
    await link.call("close.begin", { card: request.card, mode: request.mode }),
  );
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
  const card = check(CardSchema, await link.call("close.finish", { ...request, archives, left }));
  const kept = archives.length === 0 ? "" : ` Unlanded work is archived in ${archives.join(", ")}.`;
  const stayed =
    left.length === 0
      ? ""
      : ` Left in place: ${left.map((each) => `${each.host} ${each.session} (${each.reason})`).join("; ")}.`;
  return `c-${String(card.id)} is ${card.status}.${kept}${stayed}`;
}

// cleanup and card drop (spec section 20.5), in this order: stop every writer
// (close the worker's herdr workspace, which ends Pi and the job tabs), archive
// and verify all unlanded work, remove the worktree, then close the card. Each
// step finds its own result first, so a rerun converges.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CardSchema, check, OPS } from "@fleet/protocol";
import { field, herdr, HostUnreachable, onHost, records } from "./host.ts";
import type { Link } from "./link.ts";

const ARCHIVE_SCRIPT = readFileSync(
  fileURLToPath(new URL("./archive.sh", import.meta.url)),
  "utf8",
);

type Attempt = ReturnType<typeof parsePlan>["attempts"][number];
const parsePlan = (value: unknown) => check(OPS["close.begin"].result, value);

// Deletes the task branch once its work is archived or already on the base branch.
// Prints the archive path when the archive exists. Safe to rerun.
const FINISH_SCRIPT = `clone=$1 branch=$2 base=$3 out=$4
if git -C "$clone" rev-parse --verify -q "refs/heads/$branch" >/dev/null; then
  if [ -f "$out" ] || [ "$(git -C "$clone" rev-list --count "$base..refs/heads/$branch")" -eq 0 ]; then
    git -C "$clone" branch -D "$branch" >/dev/null
  fi
fi
if [ -f "$out" ]; then echo "$out"; fi`;

const OLD_ATTEMPT_TIMEOUT_MS = 60_000;

/** Stops the writers, archives, and removes the worktree and branch. Returns the archive path, or null if there is no archive. */
async function retire(attempt: Attempt): Promise<string | null> {
  const { host, clone, branch, base, session } = attempt;
  const archiveDir = `${clone}.archive`;
  const timeout = attempt.live ? undefined : OLD_ATTEMPT_TIMEOUT_MS;
  const listed = await herdr(host, ["worktree", "list", "--cwd", clone], timeout);
  const tree = records(listed["worktrees"]).find((each) => field(each, "branch") === branch);
  if (tree !== undefined) {
    const workspace = field(tree, "open_workspace_id");
    if (workspace !== undefined) await herdr(host, ["workspace", "close", workspace], timeout);
    const path = field(tree, "path") ?? "";
    await onHost(
      host,
      ["sh", "-c", ARCHIVE_SCRIPT, "archive", path, base, archiveDir, session],
      timeout,
    );
    await onHost(host, ["git", "-C", clone, "worktree", "remove", "--force", path]);
  }
  const out = `${archiveDir}/${session}.tar.zst`;
  const archive = await onHost(host, [
    "sh",
    "-c",
    FINISH_SCRIPT,
    "finish",
    clone,
    branch,
    base,
    out,
  ]);
  return archive.trim() === "" ? null : archive.trim();
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

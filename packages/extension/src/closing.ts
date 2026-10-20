// cleanup and card drop (spec section 20.5), in this order: stop every writer
// (close the worker's herdr workspace, which ends Pi and the job tabs), archive
// and verify all unlanded work, remove the worktree, then close the card. Each
// step finds its own result first, so a rerun converges.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CardSchema, check, OPS } from "@fleet/protocol";
import { field, herdr, onHost, records } from "./host.ts";
import type { Link } from "./link.ts";

const ARCHIVE_SCRIPT = readFileSync(
  fileURLToPath(new URL("./archive.sh", import.meta.url)),
  "utf8",
);

type Attempt = NonNullable<ReturnType<typeof parsePlan>["attempt"]>;
const parsePlan = (value: unknown) => check(OPS["close.begin"].result, value);

/** Stops the writers, archives, and removes the worktree. Returns the archive path, or null if no worktree is left. */
async function retire(attempt: Attempt, archiveDir: string): Promise<string | null> {
  const { host, clone, branch, base, session } = attempt;
  const listed = await herdr(host, ["worktree", "list", "--cwd", clone]);
  const tree = records(listed["worktrees"]).find((each) => field(each, "branch") === branch);
  if (tree === undefined) return null;
  const workspace = field(tree, "open_workspace_id");
  if (workspace !== undefined) await herdr(host, ["workspace", "close", workspace]);
  const path = field(tree, "path") ?? "";
  const archive = (
    await onHost(host, ["sh", "-c", ARCHIVE_SCRIPT, "archive", path, base, archiveDir, session])
  ).trim();
  await onHost(host, ["git", "-C", clone, "worktree", "remove", "--force", path]);
  await onHost(host, ["git", "-C", clone, "branch", "-D", branch]);
  return archive;
}

export async function close(
  link: Link,
  request: { card: number; mode: "done" | "dropped"; text: string },
): Promise<string> {
  const plan = parsePlan(
    await link.call("close.begin", { card: request.card, mode: request.mode }),
  );
  const archive = plan.attempt === null ? null : await retire(plan.attempt, plan.archiveDir);
  const card = check(CardSchema, await link.call("close.finish", { ...request, archive }));
  const kept = archive === null ? "" : ` Unlanded work is archived in ${archive}.`;
  return `c-${String(card.id)} is ${card.status}.${kept}`;
}

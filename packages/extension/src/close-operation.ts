import {
  evidenceScope,
  OPERATION_TREE_SCRIPT,
  parseOperationTree,
  type OpResult,
} from "@fleet/protocol";
import { field, herdr, HostUnreachable, onHelper, worktreeOf } from "./host.ts";
import { checkEvidenceCommand } from "./scratch.ts";

export type Attempt = OpResult<"close.begin">["attempts"][number];

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
    dirty > 0 ? `${String(dirty)} uncommitted file${dirty === 1 ? "" : "s"}` : "",
  ].filter((part) => part !== "");
  return parts.join(" and ");
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
  const { host, session, clone, base } = attempt;
  let found;
  try {
    found = parseOperationTree(
      await onHelper(host, ["sh", "-c", OPERATION_TREE_SCRIPT, "tree", path, clone, base]),
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

export async function verifyOperation(
  card: number,
  plan: OpResult<"close.begin">,
  stop: StopWriters,
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
  if (operation.unverified.length > 0)
    throw new Error(
      `c-${String(card)} was not closed. The check before the writers stopped found: ${operation.unverified.join("; ")}. The writers are stopped now: close it again to check once more`,
    );
  return stopped;
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

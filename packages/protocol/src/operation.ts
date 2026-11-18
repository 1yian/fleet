import Type, { type Static } from "typebox";

export const HANDOFF_REPORTS: ReadonlySet<string> = new Set([
  "blocked",
  "needs-decision",
  "failed",
  "stopped",
  "in-review",
  "done",
  "merged",
]);

interface Recorded {
  readonly kind: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export const toWorker = (entry: Recorded): boolean =>
  entry.fields["task"] !== undefined || entry.fields["for"] === "worker";

export function operationHandoff<T extends Recorded>(entries: readonly T[]): T | undefined {
  let standing: T | undefined;
  for (const entry of entries) {
    const status = entry.fields["status"];
    if (entry.kind === "comment" && toWorker(entry)) standing = undefined;
    else if (entry.kind === "report" && typeof status === "string" && HANDOFF_REPORTS.has(status))
      standing = status === "done" ? entry : undefined;
  }
  return standing;
}

export function evidenceScope(
  card: number,
  path: string,
): { folder: string; rel: string } | undefined {
  const found = new RegExp(`^(/(?:[^/]+/)*?scratch/c-${String(card)})/(.+)$`).exec(path);
  const folder = found?.[1];
  const rel = found?.[2];
  if (folder === undefined || rel === undefined) return undefined;
  const parts = rel.split("/");
  const plain = parts.every((part) => part !== "" && part !== "." && part !== "..");
  return plain && parts[0] !== "tmp" ? { folder, rel } : undefined;
}

export const OperationPlanSchema = Type.Object({
  session: Type.String(),
  evidence: Type.String(),
  unverified: Type.Array(Type.String()),
});

export const OperationVerifiedSchema = Type.Array(
  Type.Object({
    session: Type.String(),
    head: Type.Union([Type.String(), Type.Null()]),
    clean: Type.Boolean(),
  }),
);
export type OperationVerified = Static<typeof OperationVerifiedSchema>;

export const OPERATION_TREE_SCRIPT = `set -eu
wt=$1 clone=$2 base=$3
[ -d "$wt" ] || { echo "no worktree at $wt" >&2; exit 1; }
real=$(cd "$wt" && pwd -P)
top=$(git -C "$wt" rev-parse --show-toplevel)
[ "$top" = "$real" ] || { echo "$wt is not a worktree root" >&2; exit 1; }
git -C "$clone" rev-parse --verify -q "refs/heads/$base^{commit}" >/dev/null
head=$(git -C "$wt" rev-parse HEAD)
ahead=$(git -C "$wt" rev-list --count HEAD --not "refs/heads/$base")
commits=$(git -C "$wt" log --oneline -n 10 HEAD --not "refs/heads/$base")
files=$(git -C "$wt" status --porcelain --untracked-files=all)
dirty=$(printf '%s' "$files" | grep -c '' || true)
echo "$head $ahead $dirty"
if [ -n "$commits" ]; then printf '%s\\n' "$commits" | sed 's/^/c /'; fi
if [ -n "$files" ]; then printf '%s\\n' "$files" | head -n 20 | sed 's/^/f /'; fi`;

export interface OperationTree {
  readonly head: string;
  readonly ahead: number;
  readonly dirty: number;
  readonly commits: string[];
  readonly files: string[];
}

export function parseOperationTree(output: string): OperationTree {
  const [counts = "", ...rest] = output.trimEnd().split("\n");
  const [head = "", ahead = "", dirty = ""] = counts.trim().split(" ");
  if (head === "" || !/^\d+$/.test(ahead) || !/^\d+$/.test(dirty))
    throw new Error("the worktree check printed nothing usable");
  const tagged = (tag: string): string[] =>
    rest.filter((line) => line.startsWith(`${tag} `)).map((line) => line.slice(2));
  return {
    head,
    ahead: Number(ahead),
    dirty: Number(dirty),
    commits: tagged("c"),
    files: tagged("f"),
  };
}

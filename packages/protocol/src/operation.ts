import Type from "typebox";

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
  handoff: Type.Integer(),
});

export const OPERATION_PLAN_FIELDS = {
  operation: Type.Optional(OperationPlanSchema),
  ops: Type.Optional(Type.Literal(true)),
};

export const OperationReceiptSchema = Type.Object({
  handoff: Type.Integer(),
  attempts: Type.Array(
    Type.Object({
      session: Type.String(),
      host: Type.String(),
      clone: Type.String(),
      branch: Type.String(),
      base: Type.String(),
      head: Type.String(),
      tip: Type.String(),
      state: Type.Enum(["clean", "retired"]),
    }),
  ),
});

export const CLOSE_VERIFY = {
  roles: ["mate"],
  args: Type.Object({ card: Type.Integer(), handoff: Type.Integer() }),
  result: Type.Object({}),
} as const;

const TREE_CHECKS = `set -eu
wt=$1 clone=$2 base=$3 branch=$4
[ -d "$wt" ] || { echo "no worktree at $wt" >&2; exit 1; }
real=$(cd "$wt" && pwd -P)
top=$(git -C "$wt" rev-parse --show-toplevel)
[ "$top" = "$real" ] || { echo "$wt is not a worktree root" >&2; exit 1; }
listing=$(git -C "$clone" worktree list --porcelain)
printf '%s\n' "$listing" | grep -Fx "worktree $real" >/dev/null
[ "$branch" != "$base" ]
heads=$(git -C "$clone" for-each-ref --format='%(refname) %(objectname)' refs/heads)
printf '%s\n' "$heads" | grep -q "^refs/heads/$base " || { echo "no base $base" >&2; exit 1; }
tip=$(printf '%s\n' "$heads" | awk -v r="refs/heads/$branch" '$1 == r { print $2 }')
head=$(git -C "$wt" rev-parse HEAD)
cur=$(git -C "$wt" symbolic-ref -q HEAD || true)
if [ -n "$cur" ] && [ "$cur" != "refs/heads/$branch" ]; then
  echo "$wt has $cur checked out, not its own branch" >&2
  exit 1
fi
refs=HEAD
if [ -n "$tip" ]; then refs="$refs refs/heads/$branch"; fi
ahead=$(git -C "$wt" rev-list --count $refs --not "refs/heads/$base")
commits=$(git -C "$wt" log --oneline -n 10 $refs --not "refs/heads/$base")
files=$(git -C "$wt" status --porcelain --untracked-files=all --ignored)
dirty=$(printf '%s' "$files" | grep -c '' || true)`;

export const OPERATION_TREE_SCRIPT = `${TREE_CHECKS}
echo "$head \${tip:--} $ahead $dirty"
if [ -n "$commits" ]; then printf '%s\n' "$commits" | sed 's/^/c /'; fi
if [ -n "$files" ]; then printf '%s\n' "$files" | head -n 20 | sed 's/^/f /'; fi`;

export const OPERATION_RETIRE_SCRIPT = `wanted_head=$5 wanted_tip=$6
${TREE_CHECKS}
[ "$ahead" -eq 0 ] && [ "$dirty" -eq 0 ]
[ "$head" = "$wanted_head" ] && [ "\${tip:--}" = "$wanted_tip" ]
git -C "$clone" worktree remove "$wt"
if [ -n "$tip" ]; then git -C "$clone" update-ref -d "refs/heads/$branch" "$tip"; fi
[ ! -e "$wt" ]`;

export const OPERATION_RETIRED_SCRIPT = `set -eu
wt=$1 clone=$2 base=$3 branch=$4 session=$5
[ ! -e "$wt" ]
[ "$branch" != "$base" ]
listing=$(git -C "$clone" worktree list --porcelain)
heads=$(git -C "$clone" for-each-ref --format='%(refname)' refs/heads)
printf '%s\n' "$heads" | grep -Fx "refs/heads/$base" >/dev/null
if printf '%s\n' "$listing" | grep -E "^worktree .*/$session$" >/dev/null; then exit 1; fi
if printf '%s\n' "$heads" | grep -Fx "refs/heads/$branch" >/dev/null; then exit 1; fi`;

export const OPERATION_EVIDENCE_SCRIPT = `set -eu
set -f
case $1 in "" | *[!0-9]*) exit 1 ;; esac
dir=\${FLEET_HOST_DIR:-$HOME/.fleet}/scratch
scratch=$dir/c-$1
report=$2
case $report in "$scratch"/*) ;; *) exit 1 ;; esac
rel=\${report#"$scratch"/}
case /$rel/ in *//* | */./* | */../* | /tmp/*) exit 1 ;; esac
[ ! -L "$dir" ] && [ -d "$scratch" ] && [ ! -L "$scratch" ]
path=$scratch
IFS=/
for part in $rel; do
  path=$path/$part
  if [ -L "$path" ]; then exit 1; fi
done
[ -f "$report" ] && [ -r "$report" ]`;

export interface OperationTree {
  readonly head: string;
  readonly tip: string;
  readonly ahead: number;
  readonly dirty: number;
  readonly commits: string[];
  readonly files: string[];
}

export function parseOperationTree(output: string): OperationTree {
  const [counts = "", ...rest] = output.trimEnd().split("\n");
  const [head = "", tip = "", ahead = "", dirty = ""] = counts.trim().split(" ");
  if (head === "" || tip === "" || !/^\d+$/.test(ahead) || !/^\d+$/.test(dirty))
    throw new Error("the worktree check printed nothing usable");
  const tagged = (prefix: string): string[] =>
    rest.filter((line) => line.startsWith(`${prefix} `)).map((line) => line.slice(2));
  return {
    head,
    tip,
    ahead: Number(ahead),
    dirty: Number(dirty),
    commits: tagged("c"),
    files: tagged("f"),
  };
}

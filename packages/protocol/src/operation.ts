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

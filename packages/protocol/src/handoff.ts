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

export function inEvidenceScope(card: number, path: string): boolean {
  const found = new RegExp(`^/(?:[^/]+/)*?scratch/c-${String(card)}/(.+)$`).exec(path);
  const parts = found?.[1]?.split("/");
  return (
    parts !== undefined &&
    parts.every((part) => part !== "" && part !== "." && part !== "..") &&
    parts[0] !== "tmp"
  );
}

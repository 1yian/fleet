import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type ReportStatus } from "@fleet/protocol";
import type { PullRequest } from "./github.ts";
import { getCard } from "./store.ts";
import { recordReportedPr, viewReportedPr } from "./pulls.ts";

export type MergedReport =
  | { readonly pr: string; readonly prState: "MERGED"; readonly merged: true }
  | { readonly prNote: string; readonly counts: "done" };

function asDone(prNote: string): MergedReport {
  return { prNote, counts: "done" };
}

export async function checkMergedReport(
  db: DatabaseSync,
  card: number,
  raw: unknown,
): Promise<MergedReport> {
  const { pr } = check(OPS.report.args, raw);
  const { kind, delivery } = getCard(db, card);
  if (pr === undefined) return asDone("merged was reported without a PR URL, so it counts as done");
  if (kind !== "ship" || delivery === "local-only")
    return asDone("merged does not apply to this card, so it counts as done");
  recordReportedPr(db, card, pr);
  const found = await viewReportedPr(db, card, pr);
  if (found.kind === "unknown")
    return asDone(`PR unknown: ${found.reason}. The report counts as done`);
  if (found.kind !== "found" || found.pr.state !== "MERGED")
    return asDone(`${pr} has not merged, so the report counts as done`);
  return { pr, prState: "MERGED", merged: true };
}

export function statusOf(pr: object, status: ReportStatus): ReportStatus {
  return "counts" in pr ? "done" : status;
}

export function shownFields(pr: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(pr).filter(([key]) => key !== "counts" && key !== "merged"),
  );
}

export function mergedPullRequest(pr: object): PullRequest | undefined {
  return "merged" in pr && "pr" in pr && typeof pr.pr === "string"
    ? { url: pr.pr, state: "MERGED", failed: [], pending: [] }
    : undefined;
}

import Type, { type Static } from "typebox";

export const REPORT_STATUSES = [
  "working",
  "note",
  "paused",
  "blocked",
  "needs-decision",
  "resolved",
  "in-review",
  "done",
  "merged",
  "failed",
  "stopped",
] as const;
export const ReportStatus = Type.Enum(REPORT_STATUSES);
export type ReportStatus = Static<typeof ReportStatus>;
export const PR_PATTERN = "^https://github\\.com/[^/\\s]+/[^/\\s]+/pull/[0-9]+$";
export const ReportPr = Type.Optional(Type.String({ pattern: PR_PATTERN }));

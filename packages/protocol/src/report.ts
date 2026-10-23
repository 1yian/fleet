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
  "failed",
  "stopped",
] as const;
export const ReportStatus = Type.Enum(REPORT_STATUSES);
export type ReportStatus = Static<typeof ReportStatus>;
export const ReportPr = Type.Optional(
  Type.String({ pattern: "^https://github\\.com/[^/\\s]+/[^/\\s]+/pull/[0-9]+$" }),
);

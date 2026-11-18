import Type from "typebox";
import { ReportPr } from "./report.ts";

export const ActivityMessage = Type.Object({
  t: Type.Literal("activity"),
  state: Type.Enum(["running", "idle", "waiting"]),
  progress: Type.Optional(Type.Boolean()),
});

export const CompletionEvidence = Type.Optional(
  Type.String({
    pattern: "^/",
    description:
      "Only on the done report of an ops card, and required there: the absolute path of your report in $FLEET_SCRATCH, outside the worktree and its tmp folder",
  }),
);

export const LandingFields = {
  pr: ReportPr,
  merged: Type.Optional(Type.Boolean()),
};

import Type from "typebox";
import { ReportPr } from "./report.ts";

export const ActivityMessage = Type.Object({
  t: Type.Literal("activity"),
  state: Type.Enum(["running", "idle", "waiting"]),
  progress: Type.Optional(Type.Boolean()),
});

export const LandingFields = {
  pr: ReportPr,
  merged: Type.Optional(Type.Boolean()),
};

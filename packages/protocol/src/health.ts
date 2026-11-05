import Type, { type Static } from "typebox";

export const VersionSchema = Type.Object({
  commit: Type.Union([Type.String(), Type.Null()]),
  schema: Type.Integer(),
});
export type Version = Static<typeof VersionSchema>;

export const HealthSchema = Type.Object({
  commit: Type.Union([Type.String(), Type.Null()]),
  now: Type.Integer(),
  windowStart: Type.Integer(),
  loopP50Ms: Type.Number(),
  loopP99Ms: Type.Number(),
  loopMaxMs: Type.Number(),
  lastLagMs: Type.Number(),
  lastLagAt: Type.Union([Type.Integer(), Type.Null()]),
  lastTickMs: Type.Number(),
  longestTickMs: Type.Number(),
  sockets: Type.Integer(),
  sessions: Type.Integer(),
  rssBytes: Type.Integer(),
});
export type Health = Static<typeof HealthSchema>;

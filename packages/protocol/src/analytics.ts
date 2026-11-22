import Type, { type Static } from "typebox";

const Count = Type.Integer({ minimum: 0 });
const Tokens = Type.Object({
  input: Count,
  cached: Count,
  output: Count,
});

export const AnalyticsSchema = Type.Object({
  from: Count,
  to: Count,
  hours: Type.Array(Type.Object({ at: Count, tokens: Type.Union([Tokens, Type.Null()]) })),
  lanes: Type.Array(Type.Object({ lane: Type.String(), tokens: Tokens })),
  closures: Type.Array(Type.Object({ at: Count, count: Count })),
});

export type Analytics = Static<typeof AnalyticsSchema>;

import Type, { type Static } from "typebox";

const Correlation = {
  card: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  assignment: Type.String({ pattern: "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$" }),
  attempt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
};

export const GrokReportArgs = Type.Object(
  {
    ...Correlation,
    text: Type.String({ pattern: "\\S", maxLength: 8_000 }),
    sources: Type.Union(
      [
        Type.Array(Type.String({ pattern: "\\S", maxLength: 512 }), {
          minItems: 1,
          maxItems: 16,
        }),
        Type.Literal("unavailable"),
      ],
      { description: "Source references, or the literal unavailable if no source was available" },
    ),
  },
  { additionalProperties: false },
);
export type GrokReportArgs = Static<typeof GrokReportArgs>;

export const GROK_REPORT_OPS = {
  "grok.assign": {
    roles: ["mate"],
    args: Type.Object(
      { card: Correlation.card, assignment: Type.Optional(Correlation.assignment) },
      { additionalProperties: false },
    ),
    result: Type.Object(Correlation),
  },
} as const;

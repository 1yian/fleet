import Type, { type Static } from "typebox";

const Target = Type.String();

export const FitSchema = Type.Union([
  Type.Object({
    target: Target,
    width: Type.Integer({ minimum: 200, maximum: 2000 }),
    height: Type.Integer({ minimum: 200, maximum: 2000 }),
    scale: Type.Number({ minimum: 1, maximum: 3 }),
  }),
  Type.Object({ target: Target, clear: Type.Literal(true) }),
]);

export type Fit = Static<typeof FitSchema>;

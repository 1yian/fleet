import Type, { type Static } from "typebox";
import { LaterFields } from "./later.ts";

export const BoardActionSchema = Type.Object({
  card: Type.Integer(),
  action: Type.Union([
    Type.Object({
      kind: Type.Literal("answer"),
      hold: Type.Integer(),
      choice: Type.String({ minLength: 1 }),
      written: Type.Optional(Type.Boolean()),
    }),
    Type.Object({ kind: Type.Literal("comment"), text: Type.String({ minLength: 1 }) }),
    Type.Object({ kind: Type.Literal("hold"), hold: Type.Integer(), ...LaterFields }),
  ]),
});
export type BoardAction = Static<typeof BoardActionSchema>;

export const HttpCallSchema = Type.Object({ op: Type.String(), args: Type.Unknown() });

export const HttpOutcomeSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), value: Type.Unknown() }),
  Type.Object({ ok: Type.Literal(false), error: Type.String() }),
]);
export type HttpOutcome = Static<typeof HttpOutcomeSchema>;

import Type from "typebox";

export const CooldownFileSchema = Type.Record(
  Type.String(),
  Type.Object({ untilMs: Type.Number(), reason: Type.String() }),
);

export const TiersStateSchema = Type.Object({ stateDir: Type.Optional(Type.String()) });

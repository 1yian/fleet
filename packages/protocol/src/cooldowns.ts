import Type from "typebox";

export const CooldownFileSchema = Type.Record(
  Type.String(),
  Type.Object({ untilMs: Type.Number(), reason: Type.String() }),
);

export const TiersStateSchema = Type.Object({ stateDir: Type.Optional(Type.String()) });

export const TiersAccountsSchema = Type.Object({
  accounts: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
  cooldowns: Type.Optional(
    Type.Object({
      rateLimitSeconds: Type.Optional(Type.Number({ minimum: 1 })),
      usageLimitSeconds: Type.Optional(Type.Number({ minimum: 1 })),
    }),
  ),
});

import Type from "typebox";

const Key = Type.String({ pattern: "^[A-Za-z0-9._-]+$" });

const VALIDATION_STATES = [
  "running",
  "gated",
  "passed",
  "cancelled",
  "failed",
  "unavailable",
] as const;

export const VALIDATION_OPS = {
  "validation.start": {
    roles: ["worker"],
    args: Type.Object({
      respond: Type.Optional(
        Type.Object({
          action: Type.Enum(["approve", "fix", "skip"]),
          findings: Type.Optional(Type.String()),
          instructions: Type.Optional(Type.String()),
        }),
      ),
      answer: Type.Optional(
        Type.Object({ question: Type.String({ minLength: 1 }), answer: Type.String() }),
      ),
      intent: Type.Optional(Type.String({ minLength: 1 })),
    }),
    result: Type.Object({
      validation: Type.Integer(),
      nonce: Type.String(),
      intent: Type.String(),
      reused: Type.Boolean(),
    }),
  },
  "validation.result": {
    roles: ["worker"],
    args: Type.Object({
      validation: Type.Integer(),
      state: Type.Enum(VALIDATION_STATES),
      run: Type.Optional(Type.String({ minLength: 1 })),
      outcome: Type.Optional(Type.String()),
      error: Type.Optional(Type.String({ maxLength: 20_000 })),
    }),
    result: Type.Object({ recorded: Type.Boolean(), told: Type.Boolean() }),
  },
  "validation.revalidate": {
    roles: ["mate"],
    args: Type.Object({
      validation: Type.Integer(),
      generation: Type.Integer({
        description: "The worker's process generation the failure message names",
      }),
      key: Key,
    }),
    result: Type.Object({
      validation: Type.Integer(),
      previous: Type.Integer(),
      card: Type.Integer(),
      attempts: Type.Integer(),
      repeat: Type.Boolean(),
    }),
  },
} as const;

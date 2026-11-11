import Type from "typebox";

export const CLOSING_OPS = {
  "close.begin": {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Integer(),
      landed: Type.Optional(Type.Boolean()),
    }),
    result: Type.Object({
      mode: Type.Enum(["done", "dropped"]),
      verify: Type.Boolean(),
      land: Type.Boolean(),
      attempts: Type.Array(
        Type.Object({
          session: Type.String(),
          host: Type.String(),
          clone: Type.String(),
          branch: Type.String(),
          base: Type.String(),
          live: Type.Boolean(),
        }),
      ),
      refresh: Type.Array(
        Type.Object({
          project: Type.String(),
          host: Type.String(),
          path: Type.String(),
          base: Type.String(),
        }),
      ),
    }),
  },
} as const;

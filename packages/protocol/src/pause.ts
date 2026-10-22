import Type from "typebox";

export const PAUSE_OPS = {
  "fleet.pause": {
    roles: ["mate"],
    args: Type.Object({ reason: Type.Optional(Type.String()) }),
    result: Type.Object({ since: Type.Integer(), by: Type.String(), reason: Type.String() }),
  },
  "fleet.resume": {
    roles: ["mate"],
    args: Type.Object({}),
    result: Type.Object({ resumed: Type.Boolean() }),
  },
} as const;

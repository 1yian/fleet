import Type from "typebox";

const Key = Type.String({ pattern: "^[A-Za-z0-9._-]+$" });

export const INCIDENT_OPS = {
  "incident.report": {
    roles: ["mate", "worker"],
    args: Type.Object({ error: Type.String({ minLength: 1, maxLength: 20_000 }) }),
    result: Type.Object({ incident: Type.Integer(), opened: Type.Boolean() }),
  },
  "incident.clear": {
    roles: ["mate", "worker"],
    args: Type.Object({}),
    result: Type.Object({ cleared: Type.Boolean() }),
  },
  "incident.recover": {
    roles: ["mate"],
    args: Type.Object({
      incident: Type.Integer(),
      generation: Type.Integer({
        description: "The process generation the incident names: a changed one means it is stale",
      }),
      mode: Type.Enum(["retry", "replace"]),
      key: Key,
    }),
    result: Type.Object({
      incident: Type.Integer(),
      mode: Type.Enum(["retry", "replace"]),
      actor: Type.String(),
      role: Type.Enum(["mate", "worker"]),
      lane: Type.String(),
      host: Type.String(),
      card: Type.Integer(),
      generation: Type.Integer(),
      replaced: Type.Boolean(),
    }),
  },
} as const;

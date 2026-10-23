import Type from "typebox";

const Key = Type.String({ pattern: "^[A-Za-z0-9._-]+$" });

export const INCIDENT_OPS = {
  "incident.report": {
    roles: ["mate", "worker"],
    args: Type.Object({
      error: Type.String({ minLength: 1, maxLength: 20_000 }),
      phase: Type.Optional(Type.Enum(["turn", "compaction"])),
    }),
    result: Type.Object({
      incident: Type.Integer(),
      opened: Type.Boolean(),
      classification: Type.Enum([
        "stale-module",
        "router-cooldown",
        "vendor-quota",
        "auth",
        "transient",
        "unknown",
      ]),
    }),
  },
  "incident.clear": {
    roles: ["mate", "worker"],
    args: Type.Object({ compacted: Type.Optional(Type.Boolean()) }),
    result: Type.Object({ cleared: Type.Boolean() }),
  },
  "lane.stopping": {
    roles: ["mate"],
    args: Type.Object({ lane: Type.String({ minLength: 1 }) }),
    result: Type.Object({ stopping: Type.Boolean() }),
  },
  "card.restart": {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Integer(),
      incident: Type.Optional(Type.Integer()),
      generation: Type.Optional(
        Type.Integer({
          description: "Required with incident: the process generation the incident names",
        }),
      ),
      mode: Type.Enum(["retry", "replace"]),
      key: Key,
    }),
    result: Type.Object({
      incident: Type.Union([Type.Integer(), Type.Null()]),
      mode: Type.Enum(["retry", "replace"]),
      actor: Type.String(),
      role: Type.Enum(["mate", "worker"]),
      lane: Type.String(),
      host: Type.String(),
      card: Type.Integer(),
      generation: Type.Integer(),
      replaced: Type.Boolean(),
      repeat: Type.Boolean(),
    }),
  },
} as const;

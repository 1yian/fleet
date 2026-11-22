import Type, { type Static } from "typebox";

const MAINTENANCE_KINDS = ["reload", "stow"] as const;

export const MaintenanceSchema = Type.Object({
  id: Type.Integer(),
  batch: Type.String(),
  session: Type.String(),
  lane: Type.String(),
  role: Type.Enum(["mate", "worker"]),
  host: Type.String(),
  kind: Type.Enum(MAINTENANCE_KINDS),
  state: Type.Enum(["pending", "reloading", "completed", "failed"]),
  detail: Type.String(),
});
export type Maintenance = Static<typeof MaintenanceSchema>;

export function maintenanceLine(row: Maintenance): string {
  const who = row.role === "worker" ? row.session : row.lane;
  const where = row.host === "" ? row.role : `${row.role} on ${row.host}`;
  return `${who} (${where}): ${row.kind} ${row.state} - ${row.detail}`;
}

const Batch = Type.String({ minLength: 1 });
const Rows = Type.Array(MaintenanceSchema);

export const MAINTENANCE_OPS = {
  "maintenance.request": {
    roles: ["mate"],
    args: Type.Object({ batch: Batch, kind: Type.Enum(MAINTENANCE_KINDS) }),
    result: Rows,
  },
  "maintenance.scoped": {
    roles: ["mate"],
    args: Type.Object(
      {
        batch: Batch,
        hosts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      },
      {
        description:
          "Requests reloads like maintenance.request, but enrolls only workers whose attempt host is in hosts and mates whose connection reported a host in hosts. A mate that reported no host, or any other session, is never enrolled. A cardd without this operation refuses it, so a scoped caller never falls back to enrolling everyone",
      },
    ),
    result: Rows,
  },
  "maintenance.status": {
    roles: ["mate"],
    args: Type.Object({ batch: Batch, failUnverified: Type.Optional(Type.Boolean()) }),
    result: Rows,
  },
  "maintenance.read": {
    roles: ["mate", "worker"],
    args: Type.Object({ id: Type.Integer() }),
    result: MaintenanceSchema,
  },
  "maintenance.ack": {
    roles: ["mate", "worker"],
    args: Type.Object({
      id: Type.Integer(),
      state: Type.Enum(["pending", "reloading", "failed"]),
      detail: Type.String(),
    }),
    result: MaintenanceSchema,
  },
} as const;

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
  "maintenance.status": { roles: ["mate"], args: Type.Object({ batch: Batch }), result: Rows },
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

import Type from "typebox";

export const JOB_OPS = {
  "job.start": {
    roles: ["worker"],
    args: Type.Object({
      label: Type.String({ minLength: 1 }),
      command: Type.String({ minLength: 1 }),
    }),
    result: Type.Object({
      job: Type.Integer(),
      heartbeatMs: Type.Integer({ minimum: 1 }),
    }),
  },
  "job.alive": {
    roles: ["worker"],
    args: Type.Object({ job: Type.Integer() }),
    result: Type.Object({ running: Type.Boolean() }),
  },
  "job.finish": {
    roles: ["worker"],
    args: Type.Object({ job: Type.Integer(), exitCode: Type.Integer(), outputTail: Type.String() }),
    result: Type.Object({ recorded: Type.Boolean() }),
  },
  "job.stop": {
    roles: ["worker"],
    args: Type.Object({ job: Type.Integer() }),
    result: Type.Object({ label: Type.String(), running: Type.Boolean() }),
  },
  "job.drop": {
    roles: ["worker", "mate"],
    args: Type.Object({ job: Type.Integer() }),
    result: Type.Object({
      label: Type.String(),
      state: Type.String(),
      dropped: Type.Boolean(),
    }),
  },
  jobs: {
    roles: ["worker"],
    args: Type.Object({}),
    result: Type.Array(Type.Object({ id: Type.Integer(), label: Type.String() })),
  },
} as const;

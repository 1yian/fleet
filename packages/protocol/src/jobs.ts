import Type from "typebox";

const JOB_STATES = ["running", "lost", "finished", "abandoned"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const JOB_RUNNING: JobState = "running";
const JobStateSchema = Type.Enum(JOB_STATES);

export function jobIsRunning(state: JobState): boolean {
  return state === JOB_RUNNING;
}

export function parseJobState(value: unknown): JobState {
  const found = JOB_STATES.find((state) => state === value);
  if (found === undefined) throw new Error(`bad job state ${String(value)}`);
  return found;
}

export interface JobLife {
  readonly state: JobState;
  readonly droppedAt: number | null;
}

export function startedJob(): JobLife {
  return { state: JOB_RUNNING, droppedAt: null };
}

export type JobEvent =
  | { readonly name: "alive" }
  | { readonly name: "lose" }
  | { readonly name: "finish"; readonly exitCode: number; readonly outputTail: string }
  | { readonly name: "drop" }
  | { readonly name: "abandon" };

interface JobRule {
  readonly from: JobState;
  readonly event: JobEvent["name"];
  readonly dropped: "yes" | "no" | "any";
  readonly to: JobState;
  readonly drop: "set" | "clear" | "keep";
}

const JOB_RULES = [
  { from: "running", event: "alive", dropped: "any", to: "running", drop: "keep" },
  { from: "lost", event: "alive", dropped: "no", to: "running", drop: "keep" },
  { from: "running", event: "lose", dropped: "any", to: "lost", drop: "keep" },
  { from: "running", event: "finish", dropped: "any", to: "finished", drop: "clear" },
  { from: "lost", event: "finish", dropped: "any", to: "finished", drop: "clear" },
  { from: "lost", event: "drop", dropped: "no", to: "lost", drop: "set" },
  { from: "lost", event: "drop", dropped: "yes", to: "lost", drop: "keep" },
  { from: "running", event: "abandon", dropped: "any", to: "abandoned", drop: "keep" },
] as const satisfies readonly JobRule[];

export interface JobStep {
  readonly life: JobLife;
  readonly revived: boolean;
  readonly exitCode: number | null;
  readonly outputTail: string | null;
}

export function nextJob(life: JobLife, event: JobEvent, at: number): JobStep | undefined {
  const dropped = life.droppedAt !== null;
  const rule = JOB_RULES.find(
    (each) =>
      each.from === life.state &&
      each.event === event.name &&
      (each.dropped === "any" || (each.dropped === "yes") === dropped),
  );
  if (rule === undefined) return undefined;
  if (event.name === "finish") {
    if (rule.to !== "finished") return undefined;
    return {
      life: { state: "finished", droppedAt: null },
      revived: false,
      exitCode: event.exitCode,
      outputTail: event.outputTail,
    };
  }
  if (rule.to === "finished") return undefined;
  const droppedAt = rule.drop === "set" ? at : life.droppedAt;
  return {
    life: { state: rule.to, droppedAt },
    revived: event.name === "alive" && life.state === "lost",
    exitCode: null,
    outputTail: null,
  };
}

const JobLaunchId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export const StartupFenceFields = Type.Object({
  job: Type.Integer({ minimum: 1 }),
  startupFenced: Type.Literal(true),
  startupLaunch: JobLaunchId,
  exitCode: Type.Integer(),
  lost: Type.Optional(Type.Never()),
  revived: Type.Optional(Type.Never()),
});
const StartJob = Type.Object({
  label: Type.String({ minLength: 1 }),
  command: Type.String({ minLength: 1 }),
});
const StartedJob = Type.Object({
  job: Type.Integer(),
  heartbeatMs: Type.Integer({ minimum: 1 }),
});
const CutoverBlocker = Type.Object({
  job: Type.Integer(),
  card: Type.Integer(),
  host: Type.String(),
  label: Type.String(),
  state: JobStateSchema,
});

export const JOB_OPS = {
  "job.start": {
    roles: ["worker"],
    args: StartJob,
    result: StartedJob,
  },
  "job.prepare": {
    roles: ["worker"],
    args: Type.Object({ ...StartJob.properties, launch: JobLaunchId }),
    result: Type.Union([
      StartedJob,
      Type.Object({ job: Type.Integer(), unavailable: Type.String({ minLength: 1 }) }),
    ]),
  },
  "job.register": {
    roles: ["worker"],
    args: Type.Object({
      job: Type.Integer(),
      launch: JobLaunchId,
      pid: Type.Integer({ minimum: 1 }),
    }),
    result: Type.Object({ registered: Type.Boolean() }),
  },
  "job.cutover": {
    roles: ["mate"],
    args: Type.Union([
      Type.Object({ action: Type.Enum(["status", "seal"]) }),
      Type.Object({
        action: Type.Literal("confirm-stop"),
        job: Type.Integer(),
        evidence: Type.String({ minLength: 1, maxLength: 1000 }),
      }),
    ]),
    result: Type.Union([
      Type.Object({ state: Type.Literal("open"), blockers: Type.Array(CutoverBlocker) }),
      Type.Object({
        state: Type.Literal("draining"),
        blockers: Type.Array(CutoverBlocker, { minItems: 1 }),
      }),
      Type.Object({ state: Type.Literal("ready"), blockers: Type.Tuple([]) }),
    ]),
  },
  "job.alive": {
    roles: ["worker"],
    args: Type.Object({ job: Type.Integer() }),
    result: Type.Object({ running: Type.Boolean() }),
  },
  "job.finish": {
    roles: ["worker"],
    args: Type.Object({
      job: Type.Integer(),
      exitCode: Type.Integer(),
      outputTail: Type.String(),
      beforeRegistration: Type.Optional(JobLaunchId),
      commandNotStarted: Type.Optional(Type.Literal(true)),
    }),
    result: Type.Object({ recorded: Type.Boolean() }),
  },
  "job.stop": {
    roles: ["worker"],
    args: Type.Object({ job: Type.Integer() }),
    result: Type.Union([
      Type.Object(
        {
          label: Type.String({ minLength: 1 }),
          running: Type.Literal(true),
          legacy: Type.Optional(Type.Literal(true)),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          label: Type.String({ minLength: 1 }),
          running: Type.Literal(false),
          cancelled: Type.Optional(Type.Literal(true)),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  "job.drop": {
    roles: ["worker", "mate"],
    args: Type.Object({ job: Type.Integer() }),
    result: Type.Object({
      label: Type.String(),
      state: JobStateSchema,
      dropped: Type.Boolean(),
    }),
  },
  "job.idle": {
    roles: ["worker"],
    args: Type.Object({}),
    result: Type.Object({ idle: Type.Boolean() }),
  },
  "job.running": {
    roles: ["worker"],
    args: Type.Object({ job: Type.Integer() }),
    result: Type.Object({ running: Type.Boolean() }),
  },
  jobs: {
    roles: ["worker"],
    args: Type.Object({}),
    result: Type.Array(Type.Object({ id: Type.Integer(), label: Type.String() })),
  },
} as const;

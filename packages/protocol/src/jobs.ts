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
      state: JobStateSchema,
      dropped: Type.Boolean(),
    }),
  },
  jobs: {
    roles: ["worker"],
    args: Type.Object({}),
    result: Type.Array(Type.Object({ id: Type.Integer(), label: Type.String() })),
  },
} as const;

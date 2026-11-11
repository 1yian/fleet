import Type, { type Static } from "typebox";
import { waitText, type DatedWait } from "./waits.ts";

export const PULSE_STATES = [
  "broken",
  "idle",
  "parked",
  "stalled",
  "you",
  "waiting",
  "running",
] as const;
export const NOTICES = ["none", "main", "captain", "urgent"] as const;
const OWNERS = ["captain", "main", "mate", "worker"] as const;
const WAITS_ON = ["captain", "main", "mate", "date", "pause", "nothing"] as const;

export type PulseState = (typeof PULSE_STATES)[number];
export type Notice = (typeof NOTICES)[number];

const OwnerSchema = Type.Object({
  kind: Type.Enum(OWNERS),
  name: Type.String(),
  host: Type.Union([Type.String(), Type.Null()]),
});

const RunningSchema = Type.Object({ by: Type.Enum(["turn", "job"]), what: Type.String() });

export const PulseSchema = Type.Object({
  state: Type.Enum(PULSE_STATES),
  notice: Type.Enum(NOTICES),
  owner: OwnerSchema,
  running: Type.Union([RunningSchema, Type.Null()]),
  movedAt: Type.Integer(),
  since: Type.Integer(),
  waits: Type.Enum(WAITS_ON),
  behind: Type.Union([
    Type.Object({ steps: Type.Integer(), started: Type.Integer() }),
    Type.Null(),
  ]),
});
export type Pulse = Static<typeof PulseSchema>;

export interface Pulsed {
  readonly pulse: Pulse | null;
  readonly datedWait: DatedWait | null;
}

export const PULSE_WORDS: Readonly<Record<PulseState, string>> = {
  broken: "Broken",
  idle: "Idle",
  parked: "Parked",
  stalled: "Stalled",
  you: "Waiting on you",
  waiting: "Waiting",
  running: "Running",
};

export const quietFirst = (a: Pulse, b: Pulse): number =>
  NOTICES.indexOf(b.notice) - NOTICES.indexOf(a.notice) ||
  PULSE_STATES.indexOf(a.state) - PULSE_STATES.indexOf(b.state) ||
  a.since - b.since;

export function ownerText({ kind, name, host }: Pulse["owner"]): string {
  if (kind === "captain") return "you";
  if (kind === "worker") return host === null ? "a worker" : `a worker on ${host}`;
  return kind === "main" ? "main" : `${name} (mate)`;
}

export function runningText({ pulse, datedWait }: Pulsed): string {
  if (pulse?.running !== null && pulse?.running !== undefined) return pulse.running.what;
  return datedWait?.watch === "running" ? datedWait.what : "nothing";
}

export function waitsText({ pulse, datedWait }: Pulsed): string {
  if (pulse === null) return "";
  if (pulse.waits === "date" && datedWait !== null) return waitText(datedWait);
  if (pulse.waits === "captain") return "waits on you";
  if (pulse.waits === "main") return "waits on main";
  if (pulse.waits === "mate") return `waits on ${pulse.owner.name}`;
  return pulse.waits === "pause" ? "paused by its worker" : "nothing stated";
}

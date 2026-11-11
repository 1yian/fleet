import Type, { type Static } from "typebox";
import Value from "typebox/value";

const Text = Type.String({ pattern: "\\S" });

const WaitSchema = Type.Union([
  Type.Object({ by: Type.Enum(["job", "schedule", "worker"]), id: Type.Integer() }),
  Type.Object({ by: Type.Enum(["watcher", "outside", "later"]), text: Text }),
]);
export type Wait = Static<typeof WaitSchema>;

export const RemainingStepSchema = Type.Union([
  Type.Object({
    card: Type.Integer(),
    title: Type.String(),
    status: Type.String(),
  }),
  Type.Object({ card: Type.Integer(), elsewhere: Type.Literal(true) }),
]);
export type RemainingStep = Static<typeof RemainingStepSchema>;

export const HOLD_WAIT_ARGS = {
  until: Type.Optional(
    Type.Integer({
      description:
        "A date for the hold, in ms. It needs one of job, schedule, worker, watcher, outside, or said, and remaining",
    }),
  ),
  job: Type.Optional(
    Type.Integer({ description: "With until: the id of a running job that checks the event" }),
  ),
  schedule: Type.Optional(
    Type.Integer({ description: "With until: the id of a schedule that wakes you for the event" }),
  ),
  worker: Type.Optional(
    Type.Integer({ description: "With until: the card number of a live worker that checks it" }),
  ),
  watcher: Type.Optional(
    Type.String({
      pattern: "\\S",
      description:
        "With until: who else checks the event and how, such as a scheduled wake of yours or a named script. Fleet cannot check this one, so the board marks it unchecked",
    }),
  ),
  outside: Type.Optional(
    Type.String({
      pattern: "\\S",
      description:
        "With until: the outside date or event that needs no checking, such as a quota reset at a fixed time",
    }),
  ),
  said: Type.Optional(
    Type.String({
      pattern: "\\S",
      description:
        "With until: the captain's exact words when he said later or named the date. They are checked against what he wrote",
    }),
  ),
  source: Type.Optional(Type.Enum(["chat", "board", "record"])),
  remaining: Type.Optional(
    Type.Array(Type.Integer(), {
      description:
        "With until: the cards that carry the work left besides the event. [] when none. Each step that does not depend on the event is an open card of its own, or the captain-only card that holds its decision, so it stays live. The date covers only what depends on the event",
    }),
  ),
};

export function parseWait(value: unknown): Wait | null {
  return Value.Check(WaitSchema, value) ? value : null;
}

export function parseCards(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((each): each is number => Number.isInteger(each)) : [];
}

const WATCHES = ["running", "unchecked", "outside", "later", "gone", "none"] as const;

export const DatedWaitSchema = Type.Object({
  until: Type.Integer(),
  since: Type.Integer(),
  watch: Type.Enum(WATCHES),
  what: Type.String(),
});
export type DatedWait = Static<typeof DatedWaitSchema>;

export const idlePark = (wait: Pick<DatedWait, "watch"> | undefined): boolean =>
  wait?.watch === "gone" || wait?.watch === "none";

export function waitText(wait: Pick<DatedWait, "watch" | "what">): string {
  const { watch, what } = wait;
  if (watch === "running") return `waits on ${what}`;
  if (watch === "unchecked") return `waits on ${what} (fleet cannot check it)`;
  if (watch === "outside") return `waits on an outside date: ${what}`;
  if (watch === "later") return `the captain said later: "${what}"`;
  if (watch === "gone") return `idle park, nothing running: ${what}`;
  return "idle park, nothing running";
}

function span(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)}h` : `${String(Math.floor(hours / 24))}d`;
}

export function waitLine(wait: DatedWait, now: number): string {
  const at = new Date(wait.until).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${waitText(wait)}, until ${at} (in ${span(wait.until - now)}), held ${span(now - wait.since)}`;
}

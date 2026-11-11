import Type, { type Static } from "typebox";

export const STATUSES = [
  "queued",
  "working",
  "in-review",
  "paused",
  "with-mate",
  "needs-you",
  "merging",
  "waiting",
  "done",
  "dropped",
] as const;

export const ATTENTIONS = ["blocked", "failed", "stopped"] as const;

export const Status = Type.Enum(STATUSES);
const Attention = Type.Enum(ATTENTIONS);
export type Status = Static<typeof Status>;
export type Attention = Static<typeof Attention>;

export const Shown = {
  attention: Type.Union([Attention, Type.Null()]),
  until: Type.Union([Type.Integer(), Type.Null()]),
};

export const STANDING_OPS = {
  standing: {
    roles: ["worker"],
    args: Type.Object({}),
    result: Type.Object({ status: Status, ...Shown }),
  },
} as const;

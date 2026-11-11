import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { INCIDENT_OPS } from "./incidents.ts";
import { JOB_OPS } from "./jobs.ts";
import { MAINTENANCE_OPS, MaintenanceSchema } from "./maintenance.ts";
import { MODEL_PIN } from "./model.ts";
import { NextSchema } from "./next.ts";
import { ActivityMessage, LandingFields } from "./progress.ts";
import { PulseSchema } from "./pulse.ts";
import { ReportStatus } from "./report.ts";
import { SCHEDULE_OPS, ScheduleSchema } from "./schedules.ts";
import { Shown, STANDING_OPS, Status } from "./standing.ts";
import { PlanSchema } from "./wakes.ts";
import { DatedWaitSchema, HOLD_WAIT_ARGS, RemainingStepSchema } from "./waits.ts";

export * from "./address.ts";
export * from "./branch.ts";
export * from "./cdp.ts";
export * from "./health.ts";
export * from "./http.ts";
export * from "./next.ts";
export { MaintenanceSchema, maintenanceLine, type Maintenance } from "./maintenance.ts";
export * from "./wakes.ts";
export * from "./waits.ts";
export * from "./pulse.ts";
export * from "./schedules.ts";
export * from "./cooldowns.ts";
export { REPORT_STATUSES, type ReportStatus } from "./report.ts";
export { ATTENTIONS, STATUSES, type Attention, type Status } from "./standing.ts";
export {
  JOB_RUNNING,
  jobIsRunning,
  nextJob,
  parseJobState,
  startedJob,
  type JobEvent,
  type JobLife,
  type JobState,
} from "./jobs.ts";

export const HOLDERS = ["owner", "main", "captain"] as const;
const Holder = Type.Enum(HOLDERS);
export type Holder = Static<typeof Holder>;

export const MERGE_OPTIONS = ["Approve & merge", "Request changes"] as const;

export const DELIVERIES = ["no-mistakes", "direct-PR", "local-only"] as const;
const Delivery = Type.Enum(DELIVERIES);
export type Delivery = Static<typeof Delivery>;

const CardKind = Type.Enum(["ship", "scout", "captain", "standing"]);
const Key = Type.String({ pattern: "^[A-Za-z0-9._-]+$" });
export const CAPTAIN = "captain";
const ReplyId = Type.String({ pattern: "^r-[0-9]+$" });
const ReplyTo = Type.Optional(
  Type.String({
    pattern: "^r-[0-9]+$",
    description: "The id of a reply you owe, such as r-12: this answers it",
  }),
);
export const Words = Type.String({ pattern: "\\S" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export type CardKind = Static<typeof CardKind>;
export const CardName = Type.String({
  pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
  maxLength: 40,
  description: "A short name: 2 to 4 lowercase words joined by dashes, such as ios-app-store",
});

export const CardSchema = Type.Object({
  id: Type.Integer(),
  name: Type.String(),
  title: Type.String(),
  lane: Type.String(),
  project: Nullable(Type.String()),
  kind: CardKind,
  status: Status,
  revision: Type.Integer(),
  pr: Nullable(Type.String()),
  delivery: Nullable(Delivery),
  intent: Type.String(),
  spec: Type.String(),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
export type Card = Static<typeof CardSchema>;

export const EntrySchema = Type.Object({
  id: Type.Integer(),
  card: Type.Integer(),
  author: Type.String(),
  kind: Type.String(),
  body: Type.String(),
  fields: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.Integer(),
});
export type Entry = Static<typeof EntrySchema>;

export const OwedReplySchema = Type.Object({
  id: ReplyId,
  from: Type.String(),
  owes: Type.String(),
  text: Type.String(),
  askedAt: Type.Integer(),
  resentAt: Nullable(Type.Integer()),
});
export type OwedReply = Static<typeof OwedReplySchema>;

export function howToReply(to: "worker" | "mate", card: number, id: string, from = ""): string {
  const on = `card=${String(card)}`;
  if (to === "worker") return `answer with report(status, text, replyTo="${id}")`;
  const how = `comment(${on}, text, replyTo="${id}") or hold(${on}, question, replyTo="${id}")`;
  return from === CAPTAIN ? `answer the captain on the board with ${how}` : `answer with ${how}`;
}

export const LIVE_STATES = ["starting", "idle", "running", "waiting", "exited", "lost"] as const;

export const ActivitySchema = Type.Object({ state: Type.Enum(LIVE_STATES), at: Type.Integer() });
export type Activity = Static<typeof ActivitySchema>;

export const BoardCardSchema = Type.Object({
  ...CardSchema.properties,
  activity: Nullable(ActivitySchema),
  summary: Type.String(),
  mate: Type.Boolean(),
  holder: Nullable(Holder),
  replies: Type.Array(OwedReplySchema),
  ...Shown,
  datedWait: Nullable(DatedWaitSchema),
  pulse: Nullable(PulseSchema),
});
export type BoardCard = Static<typeof BoardCardSchema>;

export const CardViewSchema = Type.Object({
  card: BoardCardSchema,
  hold: Nullable(
    Type.Object({
      entry: Type.Integer(),
      holder: Holder,
      question: Type.String(),
      options: Type.Array(Type.String()),
      until: Nullable(Type.Integer()),
      remaining: Type.Array(RemainingStepSchema),
    }),
  ),
  attempts: Type.Array(
    Type.Object({
      n: Type.Integer(),
      host: Type.String(),
      state: Type.String(),
      branch: Nullable(Type.String()),
      model: Nullable(Type.String()),
    }),
  ),
  entries: Type.Array(EntrySchema),
});
export type CardView = Static<typeof CardViewSchema>;

const AttemptPlan = Type.Object({
  session: Type.String(),
  token: Type.String(),
  resumed: Type.Boolean(),
  active: Type.Boolean(),
  connected: Type.Boolean(),
  clone: Type.String(),
  base: Type.String(),
  branch: Type.String(),
  name: Type.String(),
  lane: Type.String(),
  delivery: Nullable(Delivery),
  model: Type.Optional(Type.String({ pattern: MODEL_PIN })),
});

export const OPS = {
  "card.new": {
    roles: ["mate"],
    args: Type.Object({
      title: Type.String({ minLength: 1 }),
      name: Type.Optional(CardName),
      kind: CardKind,
      project: Type.Optional(Type.String()),
      intent: Type.Optional(Type.String()),
      spec: Type.Optional(Type.String()),
      lane: Type.Optional(
        Type.String({
          description:
            "Refused unless it is your own lane. To hand work to a second mate, comment on its lane card",
        }),
      ),
    }),
    result: CardSchema,
  },
  board: { roles: ["mate"], args: Type.Object({}), result: Type.Array(BoardCardSchema) },
  card: { roles: ["mate"], args: Type.Object({ card: Type.Integer() }), result: CardViewSchema },
  "project.yolo": {
    roles: ["mate"],
    args: Type.Object({ project: Type.String({ minLength: 1 }), on: Type.Boolean() }),
    result: Type.Object({ project: Type.String(), on: Type.Boolean() }),
  },
  projects: {
    roles: ["mate"],
    args: Type.Object({}),
    result: Type.Array(
      Type.Object({
        name: Type.String(),
        delivery: Type.String(),
        base: Type.String(),
        clones: Type.Array(Type.Object({ host: Type.String(), path: Type.String() })),
        yolo: Type.Boolean(),
      }),
    ),
  },
  comment: {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Optional(Type.Integer({ description: "The card number, such as 12 for c-12" })),
      lane: Type.Optional(
        Type.String({ description: "A lane's name: shorthand for that lane's lane card" }),
      ),
      text: Type.String({ minLength: 1 }),
      resolves: Type.Optional(Key),
      later: Type.Optional(Type.Boolean({ description: "Waits for the agent's run to end" })),
      reply: Type.Optional(
        Type.Boolean({
          description:
            "Asks for a reply to this comment: the fleet tracks it, resends it once, and tells you if it goes unanswered",
        }),
      ),
      replyTo: ReplyTo,
      withdraws: Type.Optional(
        Type.String({
          pattern: "^r-[0-9]+$",
          description: "The id of a reply you asked for and no longer need",
        }),
      ),
    }),
    result: CardSchema,
  },
  hold: {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Integer(),
      question: Type.String({
        minLength: 1,
        description:
          "Everything the hold waits on, in one text: each question numbered, with the evidence, the consequence, and your recommendation",
      }),
      options: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description:
            "Short answers to the whole hold, your recommendation first, such as 'Take all my recommendations'",
        }),
      ),
      to: Type.Optional(
        Type.Enum(["main", "captain"], {
          description:
            "Who the hold waits on: main (a second mate escalates here) or captain (only main). Omit it for a new hold to wait on the next level up, and for an open hold to stay where it is",
        }),
      ),
      ...HOLD_WAIT_ARGS,
      replyTo: ReplyTo,
    }),
    result: CardSchema,
  },
  "pane.answer": {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Integer(),
      hold: Type.Integer(),
      choice: Type.String({ minLength: 1 }),
      written: Type.Optional(Type.Boolean()),
    }),
    result: CardSchema,
  },
  release: {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Integer(),
      words: Type.Optional(Words),
      source: Type.Optional(Type.Enum(["chat", "board", "record"])),
      choice: Type.Optional(Type.String({ minLength: 1 })),
      note: Type.Optional(Type.String({ minLength: 1 })),
    }),
    result: CardSchema,
  },
  "close.begin": {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Integer(),
      landed: Type.Optional(Type.Boolean()),
      next: Type.Optional(NextSchema),
    }),
    result: Type.Object({
      mode: Type.Enum(["done", "dropped"]),
      verify: Type.Boolean(),
      land: Type.Boolean(),
      attempts: Type.Array(
        Type.Object({
          session: Type.String(),
          host: Type.String(),
          clone: Type.String(),
          branch: Type.String(),
          base: Type.String(),
          live: Type.Boolean(),
        }),
      ),
      refresh: Type.Array(
        Type.Object({
          project: Type.String(),
          host: Type.String(),
          path: Type.String(),
          base: Type.String(),
        }),
      ),
    }),
  },
  "close.finish": {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Integer(),
      mode: Type.Enum(["done", "dropped"]),
      text: Type.String({ minLength: 1 }),
      next: Type.Optional(NextSchema),
      archives: Type.Array(Type.String()),
      left: Type.Array(
        Type.Object({ session: Type.String(), host: Type.String(), reason: Type.String() }),
      ),
    }),
    result: CardSchema,
  },
  "attempt.begin": {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Integer(),
      host: Type.String({ minLength: 1 }),
      task: Type.String({ minLength: 1 }),
      delivery: Type.Optional(Delivery),
      model: AttemptPlan.properties.model,
    }),
    result: AttemptPlan,
  },
  "attempt.resume": {
    roles: ["mate"],
    args: Type.Object({ card: Type.Integer() }),
    result: AttemptPlan,
  },
  "branch.name": {
    roles: ["worker"],
    args: Type.Object({ name: Type.String({ minLength: 1 }) }),
    result: Type.Object({ branch: Type.String(), previous: Type.String() }),
  },
  "lane.plan": {
    roles: ["mate"],
    args: Type.Object({}),
    result: PlanSchema,
  },
  "replies.owed": {
    roles: ["worker"],
    args: Type.Object({}),
    result: Type.Array(ReplyId),
  },
  "hold.open": {
    roles: ["worker"],
    args: Type.Object({}),
    result: Type.Boolean(),
  },
  ...SCHEDULE_OPS,
  ...STANDING_OPS,
  ...INCIDENT_OPS,
  ...JOB_OPS,
  ...MAINTENANCE_OPS,
  report: {
    roles: ["worker"],
    args: Type.Object({
      status: ReportStatus,
      text: Type.String({ minLength: 1 }),
      key: Type.Optional(Key),
      until: Type.Optional(Type.Integer()),
      replyTo: ReplyTo,
      ...LandingFields,
    }),
    result: CardSchema,
  },
} as const;
export type OpName = keyof typeof OPS;
export type OpArgs<O extends OpName> = Static<(typeof OPS)[O]["args"]>;
export type OpResult<O extends OpName> = Static<(typeof OPS)[O]["result"]>;

export const CLOSE = {
  badMessage: 4000,
  notLive: 4001,
  superseded: 4002,
  unreadable: 4003,
} as const;

const ClientMessage = Type.Union([
  Type.Object({
    t: Type.Literal("hello"),
    token: Type.String(),
    inFile: Type.Array(Type.Integer()),
    process: Type.Optional(Type.String()),
    maintenance: Type.Optional(Type.Boolean()),
    running: Type.Optional(Type.Boolean()),
    started: Type.Optional(Type.Boolean()),
  }),
  Type.Object({ t: Type.Literal("read"), entry: Type.Integer() }),
  Type.Object({ t: Type.Literal("ack"), entry: Type.Integer() }),
  ActivityMessage,
  Type.Object({
    t: Type.Literal("call"),
    id: Type.Integer(),
    op: Type.Enum(Object.keys(OPS)),
    args: Type.Unknown(),
  }),
]);
export type ClientMessage = Static<typeof ClientMessage>;

export const BoardSchema = Type.Object({
  cards: Type.Array(BoardCardSchema),
  holds: Type.Array(
    Type.Object({
      card: Type.Integer(),
      hold: Type.Integer(),
      question: Type.String(),
      options: Type.Array(Type.String()),
      merge: Type.Boolean(),
    }),
  ),
  schedules: Type.Array(ScheduleSchema),
});
export type Board = Static<typeof BoardSchema>;

export const ThreadSchema = Type.Object({ card: CardSchema, entries: Type.Array(EntrySchema) });
export type Thread = Static<typeof ThreadSchema>;

export const PushedEntrySchema = Type.Object({
  entry: EntrySchema,
  name: Type.String(),
  again: Type.Optional(Type.Boolean()),
});

const ServerMessage = Type.Union([
  Type.Object({
    t: Type.Literal("welcome"),
    session: Type.String(),
    role: Type.Enum(["mate", "worker"]),
  }),
  Type.Object({
    t: Type.Literal("entry"),
    ...PushedEntrySchema.properties,
    mode: Type.Enum(["steer", "followUp"]),
  }),
  Type.Object({
    t: Type.Literal("result"),
    id: Type.Integer(),
    ok: Type.Literal(true),
    value: Type.Unknown(),
  }),
  Type.Object({
    t: Type.Literal("result"),
    id: Type.Integer(),
    ok: Type.Literal(false),
    error: Type.String(),
  }),
  Type.Object({ t: Type.Literal("maintenance"), request: MaintenanceSchema }),
]);
export type ServerMessage = Static<typeof ServerMessage>;

export function check<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (Value.Check(schema, value)) return value;
  const [first] = Value.Errors(schema, value);
  throw new Error(`invalid ${first?.instancePath ?? ""}: ${first?.message ?? "bad value"}`);
}

export const parseClientMessage = (text: string): ClientMessage =>
  check(ClientMessage, JSON.parse(text));
export const parseServerMessage = (text: string): ServerMessage =>
  check(ServerMessage, JSON.parse(text));
export const isOpName = (name: string): name is OpName => Object.hasOwn(OPS, name);

import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { PlanSchema, WakeArgsSchema } from "./wakes.ts";

export * from "./branch.ts";
export * from "./wakes.ts";

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
export const REPORT_STATUSES = [
  "working",
  "note",
  "paused",
  "blocked",
  "needs-decision",
  "resolved",
  "in-review",
  "done",
  "failed",
  "stopped",
] as const;

export const ATTENTIONS = ["blocked", "failed", "stopped"] as const;

export const HOLDERS = ["owner", "main", "captain"] as const;
const Holder = Type.Enum(HOLDERS);
export type Holder = Static<typeof Holder>;

export const MERGE_OPTIONS = ["Approve & merge", "Request changes"] as const;

export const DELIVERIES = ["no-mistakes", "direct-PR", "local-only"] as const;
const Delivery = Type.Enum(DELIVERIES);
export type Delivery = Static<typeof Delivery>;

const Status = Type.Enum(STATUSES);
const Attention = Type.Enum(ATTENTIONS);
const CardKind = Type.Enum(["ship", "scout", "captain", "standing"]);
const ReportStatus = Type.Enum(REPORT_STATUSES);
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

export type Status = Static<typeof Status>;
export type Attention = Static<typeof Attention>;
export type CardKind = Static<typeof CardKind>;
export type ReportStatus = Static<typeof ReportStatus>;

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
  escalatedAt: Nullable(Type.Integer()),
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
  attention: Nullable(Attention),
  pausedUntil: Nullable(Type.Integer()),
});
export type BoardCard = Static<typeof BoardCardSchema>;

export const CardViewSchema = Type.Object({
  card: BoardCardSchema,
  hold: Nullable(
    Type.Object({
      holder: Holder,
      question: Type.String(),
      options: Type.Array(Type.String()),
      until: Nullable(Type.Integer()),
    }),
  ),
  attempts: Type.Array(
    Type.Object({
      n: Type.Integer(),
      host: Type.String(),
      state: Type.String(),
      branch: Nullable(Type.String()),
    }),
  ),
  entries: Type.Array(EntrySchema),
});
export type CardView = Static<typeof CardViewSchema>;

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
      now: Type.Optional(Type.Boolean()),
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
      until: Type.Optional(Type.Integer()),
      replyTo: ReplyTo,
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
    }),
    result: Type.Object({
      mode: Type.Enum(["done", "dropped"]),
      verify: Type.Boolean(),
      land: Type.Boolean(),
      noRepoHint: Type.Optional(Type.String()),
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
      replace: Type.Optional(Type.Boolean()),
      task: Type.String({ minLength: 1 }),
      delivery: Type.Optional(Delivery),
    }),
    result: Type.Object({
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
    }),
  },
  "branch.name": {
    roles: ["worker"],
    args: Type.Object({ name: Type.String({ minLength: 1 }) }),
    result: Type.Object({ branch: Type.String(), previous: Type.String() }),
  },
  "job.start": {
    roles: ["worker"],
    args: Type.Object({
      label: Type.String({ minLength: 1 }),
      command: Type.String({ minLength: 1 }),
      review: Type.Optional(Type.String({ minLength: 1 })),
    }),
    result: Type.Object({
      job: Type.Integer(),
      heartbeatMs: Type.Integer({ minimum: 1 }),
      key: Nullable(Key),
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
  jobs: {
    roles: ["worker"],
    args: Type.Object({}),
    result: Type.Array(Type.Object({ id: Type.Integer(), label: Type.String() })),
  },
  "lane.plan": {
    roles: ["mate"],
    args: Type.Object({}),
    result: PlanSchema,
  },
  wake: {
    roles: ["mate"],
    args: WakeArgsSchema,
    result: Type.Object({ entry: Type.Integer() }),
  },
  report: {
    roles: ["worker"],
    args: Type.Object({
      status: ReportStatus,
      text: Type.String({ minLength: 1 }),
      key: Type.Optional(Key),
      until: Type.Optional(Type.Integer()),
      replyTo: ReplyTo,
    }),
    result: CardSchema,
  },
} as const;
export type OpName = keyof typeof OPS;
export type OpArgs<O extends OpName> = Static<(typeof OPS)[O]["args"]>;
export type OpResult<O extends OpName> = Static<(typeof OPS)[O]["result"]>;

const ClientMessage = Type.Union([
  Type.Object({
    t: Type.Literal("hello"),
    token: Type.String(),
    inFile: Type.Array(Type.Integer()),
  }),
  Type.Object({ t: Type.Literal("ack"), entry: Type.Integer() }),
  Type.Object({ t: Type.Literal("activity"), state: Type.Enum(["running", "idle", "waiting"]) }),
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
});
export type Board = Static<typeof BoardSchema>;

export const VersionSchema = Type.Object({
  commit: Type.Union([Type.String(), Type.Null()]),
  schema: Type.Integer(),
});
export type Version = Static<typeof VersionSchema>;

export const ThreadSchema = Type.Object({ card: CardSchema, entries: Type.Array(EntrySchema) });
export type Thread = Static<typeof ThreadSchema>;

export const BoardActionSchema = Type.Object({
  card: Type.Integer(),
  revision: Type.Integer(),
  action: Type.Union([
    Type.Object({
      kind: Type.Literal("answer"),
      hold: Type.Integer(),
      choice: Type.String({ minLength: 1 }),
      written: Type.Optional(Type.Boolean()),
    }),
    Type.Object({ kind: Type.Literal("comment"), text: Type.String({ minLength: 1 }) }),
    Type.Object({
      kind: Type.Literal("hold"),
      until: Type.Integer(),
      reason: Type.String({ minLength: 1 }),
    }),
  ]),
});
export type BoardAction = Static<typeof BoardActionSchema>;

export const HttpCallSchema = Type.Object({ op: Type.String(), args: Type.Unknown() });

export const HttpOutcomeSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), value: Type.Unknown() }),
  Type.Object({ ok: Type.Literal(false), error: Type.String() }),
]);
export type HttpOutcome = Static<typeof HttpOutcomeSchema>;

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
    lowWater: Type.Integer(),
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

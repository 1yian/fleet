// The wire protocol between cardd, the fleet extension, and the board. Each
// schema is the single source of its type and its validator.
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";

export const STATUSES = [
  "queued",
  "working",
  "in-review",
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

/** Who a hold waits on. The owner is the card's own mate. Main is the owner of its own cards. */
export const HOLDERS = ["owner", "main", "captain"] as const;
const Holder = Type.Enum(HOLDERS);
export type Holder = Static<typeof Holder>;

/** The options of a merge question (spec section 7.5). */
export const MERGE_OPTIONS = ["Approve & merge", "Request changes"] as const;

const Status = Type.Enum(STATUSES);
const CardKind = Type.Enum(["ship", "scout", "captain", "standing"]);
const ReportStatus = Type.Enum(REPORT_STATUSES);
const Key = Type.String({ pattern: "^[A-Za-z0-9._-]+$" });
/** The captain's quoted words: at least one character that is not whitespace. */
export const Words = Type.String({ pattern: "\\S" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export type Status = Static<typeof Status>;
export type CardKind = Static<typeof CardKind>;
export type ReportStatus = Static<typeof ReportStatus>;

/** A card's short name, like a task ID: lowercase words joined by dashes. herdr shows it. */
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

/** Each operation: who may call it, its arguments, and its result. */
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
  board: { roles: ["mate"], args: Type.Object({}), result: Type.Array(CardSchema) },
  projects: {
    roles: ["mate"],
    args: Type.Object({}),
    result: Type.Array(
      Type.Object({
        name: Type.String(),
        delivery: Type.String(),
        base: Type.String(),
        hosts: Type.Array(Type.String()),
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
  grant: {
    roles: ["mate"],
    args: Type.Object({
      lane: Type.Optional(Type.String()),
      card: Type.Optional(Type.Integer()),
      words: Words,
      source: Type.Enum(["chat", "board", "record"]),
      may: Type.String({ minLength: 1 }),
      merge: Type.Boolean(),
      limits: Type.Optional(Type.String()),
      alwaysAsks: Type.Optional(Type.String()),
      project: Type.Optional(Type.String()),
      branch: Type.Optional(Type.String()),
      expires: Type.Optional(Type.Integer()),
    }),
    result: Type.Object({ grant: Type.Integer() }),
  },
  merge: {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Integer(),
      words: Type.Optional(Words),
      source: Type.Optional(Type.Enum(["chat", "board", "record"])),
    }),
    result: CardSchema,
  },
  "close.begin": {
    roles: ["mate"],
    args: Type.Object({ card: Type.Integer(), mode: Type.Enum(["done", "dropped"]) }),
    result: Type.Object({
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
      /** The card's name and lane, for the worker's place in herdr. */
      name: Type.String(),
      lane: Type.String(),
    }),
  },
  "job.start": {
    roles: ["worker"],
    args: Type.Object({
      label: Type.String({ minLength: 1 }),
      command: Type.String({ minLength: 1 }),
    }),
    result: Type.Object({ job: Type.Integer(), heartbeatMs: Type.Integer({ minimum: 1 }) }),
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
  report: {
    roles: ["worker"],
    args: Type.Object({
      status: ReportStatus,
      text: Type.String({ minLength: 1 }),
      key: Type.Optional(Key),
      until: Type.Optional(Type.Integer()),
      pr: Type.Optional(Type.String({ pattern: "^https://" })),
    }),
    result: CardSchema,
  },
} as const;
export type OpName = keyof typeof OPS;
export type OpArgs<O extends OpName> = Static<(typeof OPS)[O]["args"]>;

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

/** The board (spec section 21): what it shows, and the captain's actions. */
/** A card as the board shows it: the card and the latest thing the captain would read on it. */
export const BoardCardSchema = Type.Object({
  ...CardSchema.properties,
  summary: Type.String(),
  /** Whether the card is a second mate's lane card, which the board shows under Mates. */
  mate: Type.Boolean(),
  /** Who the card's open hold waits on, or null when it has none. */
  holder: Nullable(Holder),
});
export type BoardCard = Static<typeof BoardCardSchema>;

export const BoardSchema = Type.Object({
  cards: Type.Array(BoardCardSchema),
  /** The holds that wait on the captain: at most one for each card. Nothing else is his to answer. */
  holds: Type.Array(
    Type.Object({
      card: Type.Integer(),
      /** The entry that wrote the hold as it stands. An answer names it, so an answer to an older hold is refused. */
      hold: Type.Integer(),
      question: Type.String(),
      options: Type.Array(Type.String()),
      merge: Type.Boolean(),
    }),
  ),
});
export type Board = Static<typeof BoardSchema>;

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
      /** The captain typed the answer instead of picking an option. */
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

/** The body of POST /call, for scripts that act as a session with its token. */
export const HttpCallSchema = Type.Object({ op: Type.String(), args: Type.Unknown() });

const ServerMessage = Type.Union([
  Type.Object({
    t: Type.Literal("welcome"),
    session: Type.String(),
    role: Type.Enum(["mate", "worker"]),
    lowWater: Type.Integer(),
  }),
  Type.Object({
    t: Type.Literal("entry"),
    entry: EntrySchema,
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

/** Checks a value against a schema. Throws one readable error that names the first problem. */
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

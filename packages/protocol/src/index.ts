// The wire protocol between cardd, the fleet extension, and the board. Each
// schema is the single source of its type and its validator.
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";

export const STATUSES = [
  "queued",
  "working",
  "in-review",
  "with-mate",
  "with-first-mate",
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

const Status = Type.Enum(STATUSES);
const CardKind = Type.Enum(["ship", "scout", "captain", "standing"]);
const ReportStatus = Type.Enum(REPORT_STATUSES);
const Key = Type.String({ pattern: "^[A-Za-z0-9._-]+$" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export type Status = Static<typeof Status>;
export type CardKind = Static<typeof CardKind>;
export type ReportStatus = Static<typeof ReportStatus>;

export const CardSchema = Type.Object({
  id: Type.Integer(),
  title: Type.String(),
  lane: Type.String(),
  project: Nullable(Type.String()),
  kind: CardKind,
  status: Status,
  revision: Type.Integer(),
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
      kind: CardKind,
      project: Type.Optional(Type.String()),
      intent: Type.Optional(Type.String()),
      spec: Type.Optional(Type.String()),
    }),
    result: CardSchema,
  },
  board: { roles: ["mate"], args: Type.Object({}), result: Type.Array(CardSchema) },
  comment: {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Integer(),
      text: Type.String({ minLength: 1 }),
      resolves: Type.Optional(Key),
      now: Type.Optional(Type.Boolean()),
    }),
    result: CardSchema,
  },
  ask: {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Integer(),
      question: Type.String({ minLength: 1 }),
      options: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    }),
    result: CardSchema,
  },
  answer: {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Integer(),
      words: Type.String({ minLength: 1 }),
      source: Type.Enum(["chat", "board", "record"]),
    }),
    result: CardSchema,
  },
  handback: {
    roles: ["mate"],
    args: Type.Object({ card: Type.Integer(), guidance: Type.String({ minLength: 1 }) }),
    result: CardSchema,
  },
  hold: {
    roles: ["mate"],
    args: Type.Object({
      card: Type.Integer(),
      until: Type.Integer(),
      reason: Type.String({ minLength: 1 }),
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
      clone: Type.String(),
      base: Type.String(),
      branch: Type.String(),
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

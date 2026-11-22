import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { check, type Entry } from "@fleet/protocol";
import Type, { type Static } from "typebox";
import { WebSocket } from "ws";
import { reviewDecision, reviewPreview } from "./review-completion.ts";
import { lavishRequest } from "./review-session.ts";
import { factsFrom } from "./status.ts";
import { addEntry, cardEntries, transaction, workerOf } from "./store.ts";

const AUTHOR = "lavish";
const SOURCE = "lavish-source";
const Chat = Type.Object({
  chat_revision: Type.Integer({ minimum: 0 }),
  chat: Type.Array(
    Type.Object({
      role: Type.Union([Type.Literal("agent"), Type.Literal("user")]),
      text: Type.String(),
      at: Type.String(),
      kind: Type.Optional(Type.String()),
      prompt_id: Type.Optional(Type.String()),
      anchor: Type.Optional(Type.Unknown()),
      attachments: Type.Optional(Type.Unknown()),
    }),
  ),
});
const Event = Type.Object({ type: Type.String(), data: Type.Unknown() });
type ChatState = Static<typeof Chat>;

interface Binding {
  readonly card: number;
  readonly identity: string;
  readonly round: number;
  readonly reviewKeys: readonly string[];
  readonly session: string;
  readonly question: string;
  readonly requests: readonly number[];
  readonly source: URL;
  readonly worker: string;
}

interface Moment {
  readonly chat: ChatState | undefined;
  readonly sessionEnded: boolean | null;
  readonly ended: boolean;
}

interface Submission {
  readonly at: string;
  readonly prompts: { id: string; text: string }[];
}

function submissions(chat: ChatState): Submission[] {
  const batches: Submission[] = [];
  const occurrences = new Map<string, number>();
  for (const { role, text, at, kind, prompt_id, anchor, attachments } of chat.chat) {
    if (role !== "user") continue;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([at, kind, prompt_id, text, anchor, attachments]))
      .digest("hex");
    const ordinal = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, ordinal + 1);
    const last = batches.at(-1);
    const batch = last?.at === at ? last : { at, prompts: [] };
    if (batch !== last) batches.push(batch);
    batch.prompts.push({ id: `${fingerprint}:${String(ordinal)}`, text });
  }
  return batches;
}

const promptIds = (chat: ChatState | undefined): string[] =>
  chat === undefined ? [] : submissions(chat).flatMap(({ prompts }) => prompts.map(({ id }) => id));

function seenPrompts(entries: readonly Entry[], { source }: Binding): ReadonlySet<string> {
  return new Set(
    entries.flatMap(({ author, kind, fields }) => {
      const prompts = fields["sourcePrompts"];
      if (
        author !== AUTHOR ||
        kind !== "review-feedback" ||
        fields["upstream"] !== source.href ||
        !Array.isArray(prompts)
      )
        return [];
      return prompts.filter((id) => typeof id === "string");
    }),
  );
}

function noticeFor(entries: readonly Entry[], { requests, source }: Binding): Entry[] {
  return entries.filter(
    ({ author, kind, fields }) =>
      author === "fleet" &&
      kind === "note" &&
      fields["fleetReview"] === true &&
      fields["upstream"] === source.href &&
      JSON.stringify(fields["requests"]) === JSON.stringify(requests),
  );
}

function baselineOf(entries: readonly Entry[], binding: Binding): ReadonlySet<string> | undefined {
  const baseline = noticeFor(entries, binding).find(({ fields }) =>
    Array.isArray(fields["baseline"]),
  )?.fields["baseline"];
  return Array.isArray(baseline)
    ? new Set(baseline.filter((id) => typeof id === "string"))
    : undefined;
}

function addReceipt(
  db: DatabaseSync,
  binding: Binding,
  body: string,
  prompts: string[],
  sessionEnded: boolean | null,
): void {
  addEntry(
    db,
    {
      card: binding.card,
      author: AUTHOR,
      kind: "review-feedback",
      body,
      fields: {
        source: SOURCE,
        round: binding.round,
        reviewKeys: binding.reviewKeys,
        session: binding.session,
        upstream: binding.source.href,
        sessionEnded,
        sourcePrompts: prompts,
      },
    },
    [binding.worker],
  );
}

function appendFeedback(
  db: DatabaseSync,
  binding: Binding,
  entries: readonly Entry[],
  { chat, sessionEnded, ended }: Moment,
  baseline: ReadonlySet<string>,
): boolean {
  const seen = seenPrompts(entries, binding);
  const pending = (chat === undefined ? [] : submissions(chat))
    .map(({ prompts }) => prompts.filter(({ id }) => !seen.has(id) && !baseline.has(id)))
    .filter((fresh) => fresh.length > 0);
  if (ended) addReceipt(db, binding, "", [], true);
  for (const fresh of pending) {
    addReceipt(
      db,
      binding,
      fresh.map(({ text }) => text).join("\n\n"),
      fresh.map(({ id }) => id),
      sessionEnded,
    );
  }
  return ended || pending.length > 0;
}

async function mapped(source: URL): Promise<boolean> {
  const response = await lavishRequest(
    new URL(`${source.pathname.replace("/session/", "/api/")}/layout-warnings`, source),
  ).catch(() => undefined);
  await response?.body?.cancel().catch(() => undefined);
  return response?.ok === true;
}

function listen(
  binding: Binding,
  receive: (moment: Moment) => void,
  closed: () => void,
): WebSocket {
  const { source } = binding;
  const url = new URL(source.pathname.replace("/session/", "/events/"), source);
  url.protocol = source.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, {
    origin: source.origin,
    handshakeTimeout: 10000,
    maxPayload: 16 * 1024 * 1024,
  });
  let revision = -1;
  let initial: ChatState | undefined;
  let fenced = false;
  let ready = false;
  let open = true;
  let ambiguous = false;
  let known = new Set<string>();
  const waiting: Moment[] = [];
  const deliver = (moment: Moment) => {
    if (!ready) {
      waiting.push(moment);
      return;
    }
    try {
      receive(moment);
    } catch (error) {
      console.warn(
        `Lavish source feedback for c-${String(binding.card)} could not be recorded`,
        error,
      );
      socket.terminate();
    }
  };
  socket.on("error", () => undefined);
  socket.on("close", closed);
  socket.on("pong", () => {
    if (fenced) return;
    fenced = true;
    known = new Set(promptIds(initial));
    deliver({ chat: initial, sessionEnded: null, ended: false });
    void mapped(source).then((present) => {
      if (!present) {
        socket.terminate();
        return;
      }
      ready = true;
      for (const moment of waiting.splice(0)) deliver(moment);
    });
  });
  const ended = () => {
    if (!fenced) open = false;
    else if (open) {
      open = false;
      ambiguous = true;
      deliver({ chat: undefined, sessionEnded: null, ended: true });
    }
  };
  const synced = (chat: ChatState) => {
    if (!fenced) {
      if (initial === undefined) socket.ping();
      initial = chat;
      return;
    }
    const ids = promptIds(chat);
    if (ids.some((id) => !known.has(id))) {
      if (!ambiguous) open = true;
      deliver({ chat, sessionEnded: ambiguous ? null : false, ended: false });
      ambiguous = false;
    }
    known = new Set(ids);
  };
  socket.on("message", (raw: Buffer) => {
    try {
      const message = check(Event, JSON.parse(raw.toString("utf8")));
      if (message.type === "ended") ended();
      if (message.type !== "chat-sync") return;
      const chat = check(Chat, message.data);
      if (chat.chat_revision <= revision) return;
      revision = chat.chat_revision;
      synced(chat);
    } catch (error) {
      console.warn(`Lavish source feedback for c-${String(binding.card)} could not be read`, error);
      socket.terminate();
    }
  });
  return socket;
}

const same = (a: Binding | undefined, b: Binding | undefined): boolean =>
  a?.identity === b?.identity && a?.worker === b?.worker;

export class SourceReviews {
  private readonly candidates = new Set<number>();
  private readonly watching = new Map<number, { binding: Binding; socket: WebSocket }>();
  private readonly claims = new Map<string, { card: number; requests: string }>();
  private cursor = 0;

  private readonly db: DatabaseSync;
  private readonly origins: ReadonlyMap<string, string>;
  private readonly notify: (worker: string) => void;

  constructor(
    db: DatabaseSync,
    origins: ReadonlyMap<string, string>,
    notify: (worker: string) => void,
  ) {
    this.db = db;
    this.origins = origins;
    this.notify = notify;
  }

  private discover(): void {
    const rows = this.db
      .prepare(`SELECT DISTINCT card FROM entries
      WHERE id > ? AND kind = 'hold' AND json_type(fields, '$.review') = 'text'`)
      .all(this.cursor);
    for (const row of rows) {
      this.candidates.add(Number(row["card"]));
    }
    this.cursor = Number(this.db.prepare("SELECT max(id) AS id FROM entries").get()?.["id"]);
  }

  refresh(): void {
    if (this.origins.size === 0) return;
    this.discover();
    for (const card of this.candidates) this.refreshCard(card);
  }

  private held(card: number, now: number) {
    const entries = cardEntries(this.db, card);
    const hold = factsFrom(entries).hold;
    if (hold?.review === undefined) {
      this.candidates.delete(card);
      return undefined;
    }
    const source = reviewPreview(hold, this.origins, now);
    if (source === undefined || !reviewDecision(entries, hold)) return undefined;
    return { hold, source, session: hold.review, requests: hold.reviewRequests ?? [] };
  }

  private binding(card: number): Binding | undefined {
    const held = this.held(card, Date.now());
    const worker = workerOf(this.db, card);
    if (held === undefined || worker === undefined) return undefined;
    const { hold, source, session, requests } = held;
    return {
      card,
      identity: JSON.stringify([source.href, requests]),
      round: hold.entry,
      reviewKeys: hold.keys,
      question: hold.question,
      requests,
      worker,
      source,
      session,
    };
  }

  private owns(card: number): boolean {
    const held = this.held(card, Infinity);
    for (const [href, claim] of this.claims)
      if (
        claim.card === card &&
        (held === undefined ||
          href !== held.source.href ||
          claim.requests !== JSON.stringify(held.requests))
      )
        this.claims.delete(href);
    if (held === undefined) return false;
    const claim = this.claims.get(held.source.href);
    if (claim === undefined)
      this.claims.set(held.source.href, { card, requests: JSON.stringify(held.requests) });
    return (claim?.card ?? card) === card;
  }

  private refreshCard(card: number): void {
    const watching = this.watching.get(card);
    const binding = this.owns(card) ? this.binding(card) : undefined;
    if (same(watching?.binding, binding)) return;
    this.watching.delete(card);
    watching?.socket.terminate();
    if (binding === undefined) return;
    const socket = listen(
      binding,
      (moment) => {
        this.record(binding, moment);
      },
      () => {
        if (this.watching.get(card)?.binding === binding) this.watching.delete(card);
      },
    );
    this.watching.set(card, { binding, socket });
  }

  private record(listening: Binding, moment: Moment): void {
    if (this.watching.get(listening.card)?.binding !== listening) return;
    const changed = transaction(this.db, () => {
      const binding = this.binding(listening.card);
      if (binding === undefined || !same(binding, listening)) return false;
      const entries = cardEntries(this.db, binding.card);
      const notice = !noticeFor(entries, binding).some(
        ({ fields }) => fields["worker"] === binding.worker,
      );
      const baseline = baselineOf(entries, binding) ?? new Set(promptIds(moment.chat));
      if (notice)
        addEntry(
          this.db,
          {
            card: binding.card,
            author: "fleet",
            kind: "note",
            body: binding.question,
            fields: {
              fleetReview: true,
              requests: binding.requests,
              upstream: binding.source.href,
              worker: binding.worker,
              baseline: [...baseline],
            },
          },
          [binding.worker],
        );
      return appendFeedback(this.db, binding, entries, moment, baseline) || notice;
    });
    if (changed) this.notify(listening.worker);
  }
}

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
  readonly round: number;
  readonly reviewKeys: readonly string[];
  readonly session: string;
  readonly source: URL;
  readonly worker: string;
  readonly since: number;
}

interface Submission {
  readonly at: string;
  readonly prompts: { id: string; text: string }[];
}

function submissions(chat: ChatState, since: number): Submission[] {
  const batches: Submission[] = [];
  const occurrences = new Map<string, number>();
  for (const { role, text, at, kind, prompt_id, anchor, attachments } of chat.chat) {
    if (role !== "user" || !(Date.parse(at) >= since)) continue;
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

function seenPrompts(entries: readonly Entry[], session: string): ReadonlySet<string> {
  return new Set(
    entries.flatMap(({ author, kind, fields }) => {
      const prompts = fields["sourcePrompts"];
      if (
        author !== AUTHOR ||
        kind !== "review-feedback" ||
        fields["session"] !== session ||
        !Array.isArray(prompts)
      )
        return [];
      return prompts.filter((id) => typeof id === "string");
    }),
  );
}

function recordedNotice(entries: readonly Entry[], { round, worker }: Binding): boolean {
  return entries.some(
    ({ author, kind, fields }) =>
      author === "fleet" &&
      kind === "note" &&
      fields["fleetReview"] === true &&
      fields["round"] === round &&
      fields["worker"] === worker,
  );
}

function endNoted(entries: readonly Entry[], { round, session }: Binding): boolean {
  return entries.some(
    ({ author, kind, fields }) =>
      author === AUTHOR &&
      kind === "review-feedback" &&
      fields["session"] === session &&
      fields["round"] === round &&
      fields["sessionEnded"] === true,
  );
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
        sessionEnded,
        sourcePrompts: prompts,
      },
    },
    [binding.worker],
  );
}

function appendPrompts(
  db: DatabaseSync,
  binding: Binding,
  entries: readonly Entry[],
  chat: ChatState | undefined,
  ended: boolean,
  replay: boolean,
): { added: boolean; told: boolean } {
  const batches = chat === undefined ? [] : submissions(chat, binding.since);
  const seen = seenPrompts(entries, binding.session);
  const last = batches.at(-1);
  const pending = batches
    .map((batch) => ({ batch, fresh: batch.prompts.filter(({ id }) => !seen.has(id)) }))
    .filter(({ fresh }) => fresh.length > 0);
  for (const { batch, fresh } of pending) {
    addReceipt(
      db,
      binding,
      fresh.map(({ text }) => text).join("\n\n"),
      fresh.map(({ id }) => id),
      replay ? null : ended && batch === last,
    );
  }
  const told = ended && !replay && last !== undefined && pending.at(-1)?.batch === last;
  return { added: pending.length > 0, told };
}

function appendFeedback(
  db: DatabaseSync,
  binding: Binding,
  entries: readonly Entry[],
  chat: ChatState | undefined,
  ended: boolean,
  replay: boolean,
): boolean {
  const { added, told } = appendPrompts(db, binding, entries, chat, ended, replay);
  if (!ended || told || (replay && endNoted(entries, binding))) return added;
  addReceipt(db, binding, "", [], true);
  return true;
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
  receive: (chat: ChatState | undefined, ended: boolean, replay: boolean) => void,
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
  let ended = false;
  let bootstrap: ChatState | undefined;
  const deliver = (chat: ChatState | undefined, replay: boolean) => {
    const end = ended;
    ended = false;
    try {
      receive(chat, end, replay);
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
    if (bootstrap === undefined) {
      if (ended) deliver(undefined, false);
      return;
    }
    void mapped(source).then((present) => {
      const chat = bootstrap;
      bootstrap = undefined;
      if (present && chat !== undefined) deliver(chat, true);
      else socket.terminate();
    });
  });
  socket.on("message", (raw: Buffer) => {
    try {
      const message = check(Event, JSON.parse(raw.toString("utf8")));
      if (message.type === "ended") {
        ended = true;
        if (bootstrap === undefined && revision >= 0) socket.ping();
      }
      if (message.type !== "chat-sync") return;
      const chat = check(Chat, message.data);
      if (chat.chat_revision <= revision) return;
      if (revision < 0) {
        bootstrap = chat;
        socket.ping();
      } else if (bootstrap !== undefined) bootstrap = chat;
      else deliver(chat, false);
      revision = chat.chat_revision;
    } catch (error) {
      console.warn(`Lavish source feedback for c-${String(binding.card)} could not be read`, error);
      socket.terminate();
    }
  });
  return socket;
}

export class SourceReviews {
  private readonly candidates = new Set<number>();
  private readonly watching = new Map<number, { binding: Binding; socket: WebSocket }>();
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

  private binding(card: number): Binding | undefined {
    const entries = cardEntries(this.db, card);
    const hold = factsFrom(entries).hold;
    if (hold?.review === undefined) {
      this.candidates.delete(card);
      return undefined;
    }
    const source = reviewPreview(hold, this.origins, Date.now());
    if (source === undefined || !reviewDecision(entries, hold)) return undefined;
    const worker = workerOf(this.db, card);
    if (worker === undefined) return undefined;
    const since = Math.max(
      ...entries
        .filter(({ id }) => hold.reviewRequests?.includes(id))
        .map(({ createdAt }) => createdAt),
    );
    return {
      card,
      round: hold.entry,
      reviewKeys: hold.keys,
      worker,
      source,
      session: hold.review,
      since,
    };
  }

  private refreshCard(card: number): void {
    const binding = this.binding(card);
    const watching = this.watching.get(card);
    if (watching?.binding.round === binding?.round && watching?.binding.worker === binding?.worker)
      return;
    this.watching.delete(card);
    watching?.socket.terminate();
    if (binding === undefined) return;
    const socket = listen(
      binding,
      (chat, ended, replay) => {
        this.record(binding, chat, ended, replay);
      },
      () => {
        if (this.watching.get(card)?.binding === binding) this.watching.delete(card);
      },
    );
    this.watching.set(card, { binding, socket });
  }

  private record(
    binding: Binding,
    chat: ChatState | undefined,
    ended: boolean,
    replay: boolean,
  ): void {
    if (this.watching.get(binding.card)?.binding !== binding) return;
    const changed = transaction(this.db, () => {
      const entries = cardEntries(this.db, binding.card);
      const hold = factsFrom(entries).hold;
      if (hold?.entry !== binding.round || !reviewDecision(entries, hold)) return false;
      const notice = !recordedNotice(entries, binding);
      if (notice)
        addEntry(
          this.db,
          {
            card: binding.card,
            author: "fleet",
            kind: "note",
            body: hold.question,
            fields: { fleetReview: true, round: binding.round, worker: binding.worker },
          },
          [binding.worker],
        );
      return appendFeedback(this.db, binding, entries, chat, ended, replay) || notice;
    });
    if (changed) this.notify(binding.worker);
  }
}

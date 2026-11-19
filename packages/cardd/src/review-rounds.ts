import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { StaleCard } from "./board.ts";
import type { Draft } from "./change.ts";
import { mergeQuestion, writeMergeQuestion } from "./holds.ts";
import { reviewDecision, reviewPreview } from "./review-completion.ts";
import { reviewFeedback, reviewPage, sendAndEnd } from "./review-page.ts";
import { launchReview, lavishRequest, type ReviewSession } from "./review-session.ts";
import { factsFrom, holdDeferred, type Hold } from "./status.ts";
import { addEntry, cardEntries, getCard, parentOf, transaction, workerOf } from "./store.ts";

interface Active {
  readonly round: number;
  readonly launch: Promise<ReviewSession>;
  owned?: ReviewSession;
}

type Feedback = ReturnType<typeof reviewFeedback>;

function refuse(card: number, round: number, post: boolean): never {
  if (post)
    console.warn(`ignored Lavish completion for card ${String(card)}, round ${String(round)}`);
  throw new StaleCard("review round or session is no longer current; answer on the board");
}

function drop(active: Active): void {
  void active.launch.then(
    (owned) => {
      owned.stop();
    },
    () => undefined,
  );
}

function upstreamArtifact(owned: ReviewSession, url: URL): URL {
  const sdk = url.pathname === "/sdk.js";
  const path = sdk
    ? "/sdk.js"
    : owned.url.pathname.replace("/session/", "/artifact/") + "/index.html";
  const target = new URL(path, owned.url);
  for (const name of sdk
    ? ["artifact_revision", "artifact_load_token", "key"]
    : ["artifact_revision", "artifact_load_token"]) {
    const value = url.searchParams.get(name);
    if (value !== null) target.searchParams.set(name, value);
  }
  return target;
}

export class Reviews {
  readonly artifactOrigin: URL | undefined;
  private readonly db: DatabaseSync;
  private readonly origins: ReadonlyMap<string, string>;
  private readonly active = new Map<number, Active>();

  constructor(
    db: DatabaseSync,
    origins: ReadonlyMap<string, string>,
    artifactOrigin: URL | undefined,
  ) {
    this.db = db;
    this.origins = origins;
    this.artifactOrigin = artifactOrigin;
  }

  available(): ReadonlyMap<string, string> | undefined {
    return this.artifactOrigin === undefined ? undefined : this.origins;
  }

  isArtifactHost(host: string | undefined): boolean {
    return this.artifactOrigin !== undefined && host?.toLowerCase() === this.artifactOrigin.host;
  }

  current(card: number, round: number): Hold | undefined {
    const entries = cardEntries(this.db, card);
    const hold = factsFrom(entries).hold;
    const open =
      hold?.entry === round &&
      hold.review !== undefined &&
      hold.holder === "captain" &&
      !hold.merge &&
      !hold.unlanded &&
      !holdDeferred(hold, Date.now());
    return open && reviewDecision(entries, hold) ? hold : undefined;
  }

  retire(): void {
    for (const [card, active] of this.active) {
      if (this.current(card, active.round) !== undefined) continue;
      this.active.delete(card);
      drop(active);
    }
  }

  private ownedFor(url: URL): ReviewSession | undefined {
    const sdk = url.pathname === "/sdk.js";
    const key = url.searchParams.get("key") ?? "";
    const token = /^\/review-artifact\/([a-f0-9-]{36})$/.exec(url.pathname)?.[1];
    for (const { owned } of this.active.values()) {
      if (owned === undefined || owned.ended()) continue;
      if (sdk ? owned.url.pathname === `/session/${key}` : owned.token === token) return owned;
    }
    return undefined;
  }

  private async fetchArtifact(url: URL, owned: ReviewSession): Promise<Buffer | undefined> {
    const upstream = await lavishRequest(upstreamArtifact(owned, url));
    if (!upstream.ok) await upstream.body?.cancel();
    const body = upstream.ok ? Buffer.from(await upstream.arrayBuffer()) : undefined;
    this.retire();
    return this.ownedFor(url) === owned ? body : undefined;
  }

  async artifact(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.retire();
    const url = URL.parse(request.url ?? "/", "http://artifact");
    const owned = url === null || request.method !== "GET" ? undefined : this.ownedFor(url);
    if (url === null || owned === undefined) {
      response.writeHead(404).end();
      return;
    }
    const kind = url.pathname === "/sdk.js" ? "text/javascript" : "text/html";
    const body = await this.fetchArtifact(url, owned).catch(() => null);
    if (body === null) response.writeHead(502).end();
    else if (body === undefined) response.writeHead(404).end();
    else
      response
        .writeHead(200, {
          "content-type": `${kind}; charset=utf-8`,
          "cache-control": "no-store",
          "content-security-policy": "sandbox allow-scripts",
          "referrer-policy": "no-referrer",
        })
        .end(body);
  }

  private live(card: number, round: number, post: boolean): Hold {
    return this.current(card, round) ?? refuse(card, round, post);
  }

  private start(card: number, round: number, source: URL): Active {
    const existing = this.active.get(card);
    if (existing?.round === round && existing.owned?.ended() !== true) return existing;
    if (existing !== undefined) drop(existing);
    const active: Active = { round, launch: launchReview(source) };
    this.active.set(card, active);
    return active;
  }

  private async launched(card: number, round: number, active: Active): Promise<ReviewSession> {
    let owned: ReviewSession;
    try {
      owned = await active.launch;
    } catch (error) {
      if (this.active.get(card) === active) this.active.delete(card);
      throw error;
    }
    if (
      this.current(card, round) === undefined ||
      this.active.get(card) !== active ||
      owned.ended()
    ) {
      owned.stop();
      refuse(card, round, false);
    }
    active.owned = owned;
    return owned;
  }

  async page(response: ServerResponse, card: number, round: number): Promise<boolean> {
    this.retire();
    const hold = this.live(card, round, false);
    const source = reviewPreview(hold, this.origins, Date.now());
    const origin = this.artifactOrigin;
    if (source === undefined || origin === undefined) return false;
    const active = this.start(card, round, source);
    const owned = await this.launched(card, round, active);
    const page = await reviewPage(owned, origin);
    if (this.current(card, round) === undefined || this.active.get(card) !== active)
      refuse(card, round, false);
    response.writeHead(200, page.headers).end(page.html);
    return true;
  }

  private sendable(
    card: number,
    round: number,
    form: URLSearchParams,
    active: Active | undefined,
  ): ReviewSession | undefined {
    const owned = active?.round === round ? active.owned : undefined;
    const open = owned !== undefined && !owned.ended() && form.get("session") === owned.token;
    return open && this.current(card, round) !== undefined ? owned : undefined;
  }

  async submit(
    card: number,
    round: number,
    contentType: string | undefined,
    read: () => Promise<string>,
  ): Promise<Set<string>> {
    this.retire();
    this.live(card, round, true);
    if (contentType?.split(";")[0] !== "application/x-www-form-urlencoded")
      return refuse(card, round, true);
    const form = new URLSearchParams(await read());
    const active = this.active.get(card);
    const owned = this.sendable(card, round, form, active);
    if (active === undefined || owned === undefined) return refuse(card, round, true);
    const feedback = reviewFeedback(form);
    if (!(await sendAndEnd(owned.url, feedback))) return refuse(card, round, true);
    const notify = transaction(this.db, () => this.record(card, round, active, owned, feedback));
    owned.stop();
    this.active.delete(card);
    return notify;
  }

  private record(
    card: number,
    round: number,
    active: Active,
    owned: ReviewSession,
    feedback: Feedback,
  ): Set<string> {
    const open = this.current(card, round);
    if (open === undefined || this.active.get(card) !== active) return refuse(card, round, true);
    const work = getCard(this.db, card);
    const recipients = [work.lane, parentOf(this.db, work.lane), workerOf(this.db, card)].filter(
      (id): id is string => typeof id === "string",
    );
    const body = [...feedback.annotations.map(({ prompt }) => prompt), feedback.words]
      .filter((words) => words.trim() !== "")
      .join("\n\n");
    for (const [at, key] of open.keys.entries()) {
      const fields = {
        source: "lavish",
        round,
        session: owned.url.pathname,
        resolves: key,
        annotations: feedback.annotations,
      };
      const entry: Draft = { card, author: "captain", kind: "review-feedback", body, fields };
      addEntry(this.db, entry, at === 0 ? recipients : []);
    }
    const merge = mergeQuestion(this.db, work, []);
    if (merge !== undefined) recipients.push(...writeMergeQuestion(this.db, work, merge));
    return new Set(recipients);
  }
}

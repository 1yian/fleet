import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";
import type { Access } from "./access.ts";
import { boardAction, boardView, StaleCard, thread } from "./board.ts";
import { reviewDecision, reviewPreview } from "./review-completion.ts";
import { REVIEW_BODY_LIMIT, reviewFeedback, reviewPage, sendAndEnd } from "./review-page.ts";
import { lavishRequest, launchReview, type ReviewSession } from "./review-session.ts";
import { mergeQuestion, writeMergeQuestion } from "./holds.ts";
import { factsFrom, holdDeferred } from "./status.ts";
import { addEntry, cardEntries, getCard, parentOf, transaction, workerOf } from "./store.ts";
import type { Timings } from "./timing.ts";
import { version } from "./version.ts";

const CHANGED_EVERY = 1000;
const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function readBody(request: IncomingMessage, limit = Infinity): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      if (body.length > limit) return;
      body += chunk;
      if (body.length > limit) reject(new Error("request body is too large"));
    });
    request.on("end", () => {
      resolve(body);
    });
    request.on("error", reject);
  });
}

export type Channel = "tailnet" | "public";

const CLOUDFLARE_HEADER = /^(cf-|cdn-loop$)/;
const ACCESS_TOKEN_HEADER = "cf-access-jwt-assertion";

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

function canonical(authority: string): string | undefined {
  if (/[\s/?#@\\]/.test(authority)) return undefined;
  try {
    return new URL(`http://${authority}`).host;
  } catch {
    return undefined;
  }
}

function originHostname(origin: string): string | undefined {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

export class Web {
  private readonly hosts = new Set<string>();
  private readonly access: Access | undefined;
  private readonly reviewOrigins: ReadonlyMap<string, string>;
  private readonly artifactOrigin: URL | undefined;
  private readonly reviews = new Map<
    number,
    { round: number; launch: Promise<ReviewSession>; owned?: ReviewSession }
  >();

  allow(authorities: readonly string[]): void {
    for (const authority of authorities) {
      const host = canonical(authority);
      if (host === undefined)
        throw new Error(`${authority} is not a host name with an optional port`);
      if (host === this.access?.host)
        throw new Error(`${authority} is the public host, which tailnet names cannot share`);
      this.hosts.add(host);
    }
  }

  async channel(request: IncomingMessage): Promise<Channel | "refused"> {
    if (this.isArtifactHost(request)) return "refused";
    const access = this.access;
    if (access === undefined) return "tailnet";
    const header = request.headers.host;
    if ((header === undefined ? undefined : canonical(header)) === access.host)
      return this.publicChannel(request, access);
    const forwarded =
      Object.keys(request.headers).some((name) => CLOUDFLARE_HEADER.test(name)) ||
      originHostname(request.headers.origin ?? "") === access.host;
    if (!forwarded) return "tailnet";
    access.note(
      "a request that came through Cloudflare or names the public host reached another host name: the tunnel must forward the Host header unchanged",
    );
    return "refused";
  }

  private async publicChannel(
    request: IncomingMessage,
    access: Access,
  ): Promise<Channel | "refused"> {
    const origin = request.headers.origin;
    const reads =
      (request.method === "GET" || request.method === "HEAD") && !request.headers.upgrade;
    if (origin === undefined ? !reads : origin !== `https://${access.host}`) {
      access.note("the Origin is not the public host's https origin");
      return "refused";
    }
    return (await this.admitsOwner(request)) ? "public" : "refused";
  }

  private async admitsOwner(request: IncomingMessage): Promise<boolean> {
    const token = request.headers[ACCESS_TOKEN_HEADER];
    return (await this.access?.admits(typeof token === "string" ? token : undefined)) === true;
  }

  allows(request: IncomingMessage, channel: Channel): boolean {
    return channel === "public" || this.permits(request);
  }

  refuse(response: ServerResponse): void {
    reply(response, 403, { ok: false, error: "refused" });
  }

  accepted(): string {
    return `these hosts: ${[...this.hosts].join(", ")}`;
  }

  private permits(request: IncomingMessage): boolean {
    const header = request.headers.host;
    const host = header === undefined ? undefined : canonical(header);
    if (host === undefined || !this.hosts.has(host)) return false;
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    try {
      const url = new URL(origin);
      return url.protocol === "http:" && this.hosts.has(url.host);
    } catch {
      return false;
    }
  }

  private readonly live = new Set<WebSocket>();
  private quiet: NodeJS.Timeout | undefined;
  private pending = false;
  private readonly db: DatabaseSync;
  private readonly flush: (session: string) => void;
  private readonly files: string | undefined;
  private readonly timing: Timings;

  constructor(
    db: DatabaseSync,
    timing: Timings,
    flush: (session: string) => void,
    files: string | undefined,
    access: Access | undefined,
    reviewOrigins: ReadonlyMap<string, string>,
  ) {
    this.db = db;
    this.timing = timing;
    this.flush = flush;
    this.files = files === undefined ? undefined : resolve(files);
    this.access = access;
    this.reviewOrigins = reviewOrigins;
    const raw = process.env["CARDD_REVIEW_ARTIFACT_ORIGIN"];
    if (raw !== undefined) {
      const url = new URL(raw);
      if (
        access === undefined ||
        raw !== url.origin ||
        url.protocol !== "https:" ||
        url.hostname.replace(/\.$/, "") === access.host ||
        [...reviewOrigins.values()].some(
          (origin) =>
            new URL(origin).hostname.replace(/\.$/, "") === url.hostname.replace(/\.$/, ""),
        )
      )
        throw new Error(
          "review artifacts need their own HTTPS hostname, separate from board and source hosts",
        );
      this.artifactOrigin = url;
    }
  }

  private isArtifactHost(request: IncomingMessage): boolean {
    return (
      this.artifactOrigin !== undefined &&
      request.headers.host?.toLowerCase() === this.artifactOrigin.host
    );
  }

  async answerArtifact(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!this.isArtifactHost(request)) return false;
    if (!(await this.admitsOwner(request))) {
      this.refuse(response);
      return true;
    }
    this.retireReviews();
    const url = URL.parse(request.url ?? "/", "http://artifact");
    if (url === null) {
      response.writeHead(400).end();
      return true;
    }
    const sdk = url.pathname === "/sdk.js";
    const key = sdk ? /^[a-f0-9]{16}$/.exec(url.searchParams.get("key") ?? "")?.[0] : undefined;
    const token = /^\/review-artifact\/([a-f0-9-]{36})$/.exec(url.pathname)?.[1];
    const owned = [...this.reviews.values()].find(
      ({ owned }) =>
        owned !== undefined &&
        (sdk
          ? key !== undefined && owned.url.pathname === `/session/${key}`
          : owned.token === token),
    )?.owned;
    if (request.method !== "GET" || owned === undefined || owned.ended()) {
      response.writeHead(404).end();
      return true;
    }
    try {
      const artifact = new URL(
        sdk ? "/sdk.js" : owned.url.pathname.replace("/session/", "/artifact/") + "/index.html",
        owned.url,
      );
      for (const key of ["artifact_revision", "artifact_load_token"]) {
        const value = url.searchParams.get(key);
        if (value !== null) artifact.searchParams.set(key, value);
      }
      if (key !== undefined) artifact.searchParams.set("key", key);
      const upstream = await lavishRequest(artifact);
      if (!upstream.ok) {
        await upstream.body?.cancel();
        response.writeHead(404).end();
      } else {
        const body = Buffer.from(await upstream.arrayBuffer());
        this.retireReviews();
        if (![...this.reviews.values()].some((review) => review.owned === owned)) {
          response.writeHead(404).end();
          return true;
        }
        response
          .writeHead(200, {
            "content-type": sdk ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "sandbox allow-scripts",
            "referrer-policy": "no-referrer",
          })
          .end(body);
      }
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    }
    return true;
  }

  watch(socket: WebSocket): void {
    this.live.add(socket);
    socket.on("close", () => this.live.delete(socket));
  }

  private currentReview(card: number, round: number) {
    const entries = cardEntries(this.db, card);
    const hold = factsFrom(entries).hold;
    if (
      hold?.entry !== round ||
      hold.review === undefined ||
      hold.holder !== "captain" ||
      hold.merge ||
      hold.unlanded ||
      holdDeferred(hold, Date.now()) ||
      !reviewDecision(entries, hold)
    )
      return undefined;
    return hold;
  }

  private retireReviews(): void {
    for (const [card, review] of this.reviews) {
      if (this.currentReview(card, review.round) !== undefined) continue;
      this.reviews.delete(card);
      void review.launch.then(
        (owned) => owned.stop(),
        () => undefined,
      );
    }
  }

  changed(urgent = false): void {
    this.retireReviews();
    if (this.quiet !== undefined && !urgent) {
      this.pending = true;
      return;
    }
    this.announce();
  }

  private announce(): void {
    clearTimeout(this.quiet);
    this.pending = false;
    for (const socket of this.live) socket.send("changed");
    this.quiet = setTimeout(() => {
      this.quiet = undefined;
      if (this.pending) this.announce();
    }, CHANGED_EVERY);
    this.quiet.unref();
  }

  async answer(
    request: IncomingMessage,
    response: ServerResponse,
    channel: Channel,
  ): Promise<void> {
    try {
      if (!this.allows(request, channel)) {
        reply(response, 403, {
          ok: false,
          error: `cardd serves the board only to ${this.accepted()}`,
        });
        return;
      }
      const path = new URL(request.url ?? "/", "http://board").pathname;
      const review = /^\/review\/(\d+)\/(\d+)$/.exec(path);
      if (review !== null) {
        if (channel !== "public") this.refuse(response);
        else
          await this.review(request, response, {
            card: Number(review[1]),
            round: Number(review[2]),
          });
        return;
      }
      const value = await this.route(request, channel);
      if (value === undefined)
        this.serveFile(new URL(request.url ?? "/", "http://board").pathname, response);
      else reply(response, 200, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply(response, error instanceof StaleCard ? 409 : 400, { ok: false, error: message });
    }
  }

  private async review(
    request: IncomingMessage,
    response: ServerResponse,
    round: { card: number; round: number },
  ): Promise<void> {
    const { card, round: entry } = round;
    const refuse = (): never => {
      if (request.method === "POST")
        console.warn(`ignored Lavish completion for card ${card}, round ${entry}`);
      throw new StaleCard("review round or session is no longer current; answer on the board");
    };
    this.retireReviews();
    const current = () => this.currentReview(card, entry);
    const hold = current() ?? refuse();
    const source = reviewPreview(hold, this.reviewOrigins, Date.now());
    const origin = this.artifactOrigin;
    if (source === undefined || origin === undefined) {
      if (request.method === "POST") refuse();
      reply(response, 404, { ok: false, error: "review is unavailable; answer on the board" });
      return;
    }
    let review = this.reviews.get(card);
    if (request.method === "GET") {
      if (review?.round !== entry || review.owned?.ended()) {
        review?.owned?.stop();
        review = { round: entry, launch: launchReview(source) };
        this.reviews.set(card, review);
      }
      let owned: ReviewSession;
      try {
        owned = await review.launch;
      } catch (error) {
        if (this.reviews.get(card) === review) this.reviews.delete(card);
        throw error;
      }
      if (current() === undefined || this.reviews.get(card) !== review || owned.ended()) {
        owned.stop();
        refuse();
      }
      review.owned = owned;
      const page = await reviewPage(owned, origin);
      if (current() === undefined || this.reviews.get(card) !== review) refuse();
      response.writeHead(200, page.headers).end(page.html);
      return;
    }
    if (
      request.method !== "POST" ||
      request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded"
    )
      refuse();
    const form = new URLSearchParams(await readBody(request, REVIEW_BODY_LIMIT));
    const owned = review?.round === entry ? review.owned : undefined;
    if (
      owned === undefined ||
      owned.ended() ||
      form.get("session") !== owned.token ||
      current() === undefined ||
      this.reviews.get(card) !== review
    )
      return refuse();
    const feedback = reviewFeedback(form);
    if (!(await sendAndEnd(owned.url, feedback))) return refuse();
    const notify = transaction(this.db, () => {
      const open = current();
      if (open === undefined || this.reviews.get(card) !== review) return refuse();
      const work = getCard(this.db, card);
      const recipients = [work.lane, parentOf(this.db, work.lane), workerOf(this.db, card)].filter(
        (id): id is string => typeof id === "string",
      );
      addEntry(
        this.db,
        {
          card,
          author: "captain",
          kind: "review-feedback",
          body: [...feedback.annotations.map(({ prompt }) => prompt), feedback.words]
            .filter((words) => words.trim() !== "")
            .join("\n\n"),
          fields: {
            source: "lavish",
            round: entry,
            session: owned.url.pathname,
            keys: open.keys,
            annotations: feedback.annotations,
          },
        },
        recipients,
      );
      const merge = mergeQuestion(this.db, work, []);
      if (merge !== undefined) recipients.push(...writeMergeQuestion(this.db, work, merge));
      return new Set(recipients);
    });
    owned.stop();
    this.reviews.delete(card);
    for (const session of notify) this.flush(session);
    this.changed(true);
    response.writeHead(204).end();
  }

  private async route(request: IncomingMessage, channel: Channel): Promise<unknown> {
    const path = new URL(request.url ?? "/", "http://board").pathname;
    const card = /^\/api\/card\/(\d+)$/.exec(path)?.[1];
    if (request.method === "GET" && path === "/api/board")
      return boardView(
        this.db,
        this.timing,
        channel === "public" && this.artifactOrigin !== undefined ? this.reviewOrigins : undefined,
      );
    if (request.method === "GET" && path === "/api/version") return version(this.db);
    if (request.method === "GET" && card !== undefined) return thread(this.db, Number(card));
    if (request.method === "POST" && path === "/api/action") return this.act(request);
    return undefined;
  }

  private async act(request: IncomingMessage): Promise<unknown> {
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
      throw new Error("board actions must be sent as application/json");
    const body: unknown = JSON.parse(await readBody(request));
    const { notify, later } = transaction(this.db, () =>
      boardAction(this.db, body, this.timing.wall()),
    );
    for (const session of notify) this.flush(session);
    this.changed(true);
    const id: unknown =
      typeof body === "object" && body !== null ? Reflect.get(body, "card") : undefined;
    return {
      ok: true,
      card: typeof id === "number" ? getCard(this.db, id) : null,
      ...(later === undefined ? {} : { later }),
    };
  }

  private serveFile(path: string, response: ServerResponse): void {
    const root = this.files;
    const file =
      root === undefined ? undefined : join(root, normalize(path === "/" ? "/index.html" : path));
    if (
      root === undefined ||
      file === undefined ||
      !file.startsWith(root + sep) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      response.writeHead(404).end("not found");
      return;
    }
    response
      .writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" })
      .end(readFileSync(file));
  }
}

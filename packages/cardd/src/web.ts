import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";
import type { Access } from "./access.ts";
import { boardAction, boardView, StaleCard, thread } from "./board.ts";
import { mergeQuestion, writeMergeQuestion } from "./holds.ts";
import { boundReviewPage, RECORDED_REVIEW, settleReview } from "./review-completion.ts";
import { reviewPage, sendAndEnd } from "./review-page.ts";
import { getCard, transaction } from "./store.ts";
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

const READS: Readonly<Record<string, (db: DatabaseSync, timing: Timings) => unknown>> = {
  "/api/board": boardView,
  "/api/version": version,
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
  private readonly reviewOrigins: ReadonlySet<string>;

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
    const token = request.headers[ACCESS_TOKEN_HEADER];
    return (await access.admits(typeof token === "string" ? token : undefined))
      ? "public"
      : "refused";
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
    reviewOrigins: ReadonlySet<string>,
  ) {
    this.db = db;
    this.timing = timing;
    this.flush = flush;
    this.files = files === undefined ? undefined : resolve(files);
    this.access = access;
    this.reviewOrigins = reviewOrigins;
  }

  watch(socket: WebSocket): void {
    this.live.add(socket);
    socket.on("close", () => this.live.delete(socket));
  }

  changed(urgent = false): void {
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
      const value = await this.route(request);
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
    const page = boundReviewPage(this.db, round);
    if (page === RECORDED_REVIEW) {
      response.writeHead(303, { location: "/" }).end();
      return;
    }
    if (page === undefined) throw new StaleCard("review hold is no longer current");
    const session = new URL(page);
    if (!this.reviewOrigins.has(session.origin)) {
      reply(response, 404, {
        ok: false,
        error: "review origin is not configured; answer on the board",
      });
      return;
    }
    if (request.method === "GET") {
      await reviewPage(response, session);
      return;
    }
    await this.submitReview(request, response, round, session);
  }

  private async submitReview(
    request: IncomingMessage,
    response: ServerResponse,
    round: { card: number; round: number },
    session: URL,
  ): Promise<void> {
    if (
      request.method !== "POST" ||
      request.headers["content-type"] !== "application/x-www-form-urlencoded"
    )
      throw new Error("submit feedback from the Fleet review form");
    const words = new URLSearchParams(await readBody(request, 25000)).get("words");
    if (words === null || words.length > 2000)
      throw new Error("review feedback is missing or too long");
    if (boundReviewPage(this.db, round) !== session.href)
      throw new StaleCard("review hold is no longer current");
    if (!(await sendAndEnd(session, words))) {
      if (boundReviewPage(this.db, round) !== RECORDED_REVIEW) {
        reply(response, 409, {
          ok: false,
          error: "Lavish did not accept this review; answer on the board",
        });
        return;
      }
    }
    this.recordReview(response, { ...round, session: session.href, words });
  }

  private recordReview(
    response: ServerResponse,
    receipt: Parameters<typeof settleReview>[1],
  ): void {
    const notify = transaction(this.db, () => {
      const settled = settleReview(this.db, receipt);
      if (settled === undefined || settled.length === 0) return settled;
      const card = getCard(this.db, receipt.card);
      const merge = mergeQuestion(this.db, card, []);
      return merge === undefined
        ? settled
        : [...new Set([...settled, ...writeMergeQuestion(this.db, card, merge)])];
    });
    if (notify === undefined) {
      reply(response, 409, { ok: false, error: "review hold is no longer current" });
      return;
    }
    for (const session of notify) this.flush(session);
    if (notify.length > 0) this.changed(true);
    response.writeHead(303, { location: "/" }).end();
  }

  private async route(request: IncomingMessage): Promise<unknown> {
    const path = new URL(request.url ?? "/", "http://board").pathname;
    const card = /^\/api\/card\/(\d+)$/.exec(path)?.[1];
    const read = request.method === "GET" ? READS[path] : undefined;
    if (read !== undefined) return read(this.db, this.timing);
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

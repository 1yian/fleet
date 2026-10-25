import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";
import { boardAction, boardView, StaleCard, thread } from "./board.ts";
import { getCard, transaction } from "./store.ts";
import { version } from "./version.ts";

const CHANGED_EVERY = 1000;
const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const READS: Readonly<Record<string, (db: DatabaseSync) => unknown>> = {
  "/api/board": boardView,
  "/api/version": version,
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      resolve(body);
    });
    request.on("error", reject);
  });
}

function canonical(authority: string): string | undefined {
  if (/[\s/?#@\\]/.test(authority)) return undefined;
  try {
    return new URL(`http://${authority}`).host;
  } catch {
    return undefined;
  }
}

export class Web {
  private readonly hosts = new Set<string>();

  allow(authorities: readonly string[]): void {
    for (const authority of authorities) {
      const host = canonical(authority);
      if (host === undefined)
        throw new Error(`${authority} is not a host name with an optional port`);
      this.hosts.add(host);
    }
  }

  permits(request: IncomingMessage): boolean {
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

  constructor(db: DatabaseSync, flush: (session: string) => void, files: string | undefined) {
    this.db = db;
    this.flush = flush;
    this.files = files === undefined ? undefined : resolve(files);
  }

  watch(socket: WebSocket): void {
    this.live.add(socket);
    socket.on("close", () => this.live.delete(socket));
  }

  changed(): void {
    if (this.quiet !== undefined) {
      this.pending = true;
      return;
    }
    this.announce();
  }

  private announce(): void {
    this.pending = false;
    for (const socket of this.live) socket.send("changed");
    this.quiet = setTimeout(() => {
      this.quiet = undefined;
      if (this.pending) this.announce();
    }, CHANGED_EVERY);
    this.quiet.unref();
  }

  async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    try {
      if (!this.permits(request)) {
        json(403, { ok: false, error: "cardd serves the board only to its own address" });
        return;
      }
      const value = await this.route(request);
      if (value === undefined)
        this.serveFile(new URL(request.url ?? "/", "http://board").pathname, response);
      else json(200, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(error instanceof StaleCard ? 409 : 400, { ok: false, error: message });
    }
  }

  private async route(request: IncomingMessage): Promise<unknown> {
    const path = new URL(request.url ?? "/", "http://board").pathname;
    const card = /^\/api\/card\/(\d+)$/.exec(path)?.[1];
    const read = request.method === "GET" ? READS[path] : undefined;
    if (read !== undefined) return read(this.db);
    if (request.method === "GET" && card !== undefined) return thread(this.db, Number(card));
    if (request.method === "POST" && path === "/api/action") return this.act(request);
    return undefined;
  }

  private async act(request: IncomingMessage): Promise<unknown> {
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
      throw new Error("board actions must be sent as application/json");
    const body: unknown = JSON.parse(await readBody(request));
    const notify = transaction(this.db, () => boardAction(this.db, body));
    for (const session of notify) this.flush(session);
    this.changed();
    const id: unknown =
      typeof body === "object" && body !== null ? Reflect.get(body, "card") : undefined;
    return { ok: true, card: typeof id === "number" ? getCard(this.db, id) : null };
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

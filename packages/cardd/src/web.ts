// The board's side of cardd (spec section 21): its JSON API, its live socket,
// and its built files. Only the Tailscale network reaches cardd.
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";
import { boardAction, boardView, StaleCard, thread } from "./board.ts";
import { getCard, transaction } from "./store.ts";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
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

export class Web {
  private readonly live = new Set<WebSocket>();
  private readonly db: DatabaseSync;
  private readonly flush: (session: string) => void;
  private readonly files: string | undefined;

  constructor(db: DatabaseSync, flush: (session: string) => void, files: string | undefined) {
    this.db = db;
    this.flush = flush;
    this.files = files;
  }

  /** A board page that wants to hear when cards.db changes. */
  watch(socket: WebSocket): void {
    this.live.add(socket);
    socket.on("close", () => this.live.delete(socket));
  }

  changed(): void {
    for (const socket of this.live) socket.send("changed");
  }

  async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    try {
      const value = await this.route(request);
      if (value === undefined)
        this.serveFile(new URL(request.url ?? "/", "http://board").pathname, response);
      else json(200, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(error instanceof StaleCard ? 409 : 400, { ok: false, error: message });
    }
  }

  /** The API's answer, or undefined for a request that is not an API call. */
  private async route(request: IncomingMessage): Promise<unknown> {
    const path = new URL(request.url ?? "/", "http://board").pathname;
    const card = /^\/api\/card\/(\d+)$/.exec(path)?.[1];
    if (request.method === "GET" && path === "/api/board") return boardView(this.db);
    if (request.method === "GET" && card !== undefined) return thread(this.db, Number(card));
    if (request.method === "POST" && path === "/api/action") return this.act(request);
    return undefined;
  }

  private async act(request: IncomingMessage): Promise<unknown> {
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
      !file.startsWith(root) ||
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

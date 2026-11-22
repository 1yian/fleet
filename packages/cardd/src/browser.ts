import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { check, BrowserCommandSchema } from "@fleet/protocol";

export interface BrowserUpstream {
  readonly origin: string;
  readonly tokenFile: string;
}

export function browserUpstream(
  endpoint: string | undefined,
  tokenFile: string | undefined,
): BrowserUpstream | undefined {
  if (endpoint === undefined && tokenFile === undefined) return undefined;
  if (endpoint === undefined || !tokenFile)
    throw new Error("CARDD_BROWSER_ORIGIN and CARDD_BROWSER_TOKEN_FILE must be set together");
  const url = new URL(endpoint);
  if (!/^https?:$/.test(url.protocol) || url.href !== `${url.origin}/`)
    throw new Error("CARDD_BROWSER_ORIGIN must be an HTTP or HTTPS origin");
  return { origin: url.origin, tokenFile };
}

const LANE_ACTION = /^\/api\/browser\/lanes\/([a-z0-9][a-z0-9-]{0,31})\/(stream|input|command)$/;
const VIEWER = /^[a-zA-Z0-9_-]{1,48}$/;
const LIMIT = 64 * 1024;

function upstreamPath(url: URL, method: string | undefined): string | undefined {
  if (method === "GET" && url.pathname === "/api/browser/events") return "/v1/events";
  const match = LANE_ACTION.exec(url.pathname);
  const viewer = url.searchParams.get("viewer");
  if (match === null || viewer === null || !VIEWER.test(viewer)) return undefined;
  const [, lane, action] = match;
  if (method !== (action === "stream" ? "GET" : "POST")) return undefined;
  return `/v1/lanes/${lane ?? ""}/${action ?? ""}?viewer=${viewer}`;
}

function reply(response: ServerResponse, status: number): void {
  response.writeHead(status, { "cache-control": "no-store" }).end();
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (typeof chunk !== "string") throw new Error("invalid browser request");
    body += chunk;
    if (Buffer.byteLength(body) > LIMIT) throw new Error("browser request is too large");
  }
  return body;
}

function permitsPost(request: IncomingMessage): boolean {
  const type = request.headers["content-type"]?.split(";")[0]?.trim();
  return (
    type === "application/json" && request.headers.origin === `http://${request.headers.host ?? ""}`
  );
}

async function* streamChunks(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return;
      yield part.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function relay(
  response: ServerResponse,
  url: URL,
  token: string,
  body: string | undefined,
): Promise<void> {
  if (response.destroyed) return;
  const abort = new AbortController();
  const close = (): void => abort.abort();
  const timer = setTimeout(close, 10_000);
  response.once("close", close);
  try {
    const upstream = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ?? null,
      redirect: "error",
      signal: abort.signal,
    });
    if (body !== undefined || !upstream.ok || upstream.body === null) {
      await upstream.arrayBuffer();
      reply(response, upstream.ok ? 204 : upstream.status === 409 ? 409 : 502);
      return;
    }
    clearTimeout(timer);
    if (!upstream.headers.get("content-type")?.startsWith("text/event-stream")) {
      reply(response, 502);
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    response.flushHeaders();
    await pipeline(streamChunks(upstream.body.getReader()), response);
  } catch {
    if (!response.headersSent && !response.destroyed) reply(response, 502);
  } finally {
    clearTimeout(timer);
    response.off("close", close);
    abort.abort();
  }
}

export async function answerBrowser(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  config: BrowserUpstream | undefined,
): Promise<void> {
  const path = upstreamPath(url, request.method);
  if (config === undefined || path === undefined) return reply(response, 404);
  let body: string | undefined;
  if (request.method === "POST") {
    if (!permitsPost(request)) return reply(response, 403);
    try {
      body = await bodyOf(request);
      if (url.pathname.endsWith("/command")) {
        const command = check(BrowserCommandSchema, JSON.parse(body));
        body = JSON.stringify(command.t === "control" ? { t: "control", on: command.on } : command);
      }
    } catch {
      return reply(response, 400);
    }
  }
  try {
    const token = (await readFile(config.tokenFile, "utf8")).trim();
    await relay(response, new URL(path, config.origin), token, body);
  } catch {
    if (!response.headersSent && !response.destroyed) reply(response, 502);
  }
}

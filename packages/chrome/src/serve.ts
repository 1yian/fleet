import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { Gate } from "./gate.ts";
import { GUARD_HEADER } from "./marker.ts";
import type { Typing } from "./tracking.ts";

const HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:]+\])(:\d{1,5})?$/;
const SOCKET_PATH = /^\/devtools\/(browser|page)\/([A-Za-z0-9-]+)$/;
const MAX_FRAME = 512 * 1024 * 1024;

export interface Served {
  readonly server: Server;
  close(): Promise<void>;
}

interface Refusal {
  readonly status: number;
  readonly message: string;
}

function refusalOf(request: IncomingMessage): Refusal | undefined {
  if (request.headers.origin !== undefined)
    return { status: 403, message: "a web page may not use the DevTools guard" };
  if (!HOST.test(request.headers.host ?? ""))
    return { status: 400, message: "the Host header must be an IP address or localhost" };
  return undefined;
}

function plain(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "text/plain", [GUARD_HEADER]: "1" });
  response.end(`${message}\n`);
}

async function forwardJson(
  request: IncomingMessage,
  response: ServerResponse,
  upstream: string,
): Promise<void> {
  const answer = await fetch(`http://${upstream}${request.url ?? "/json"}`, {
    method: request.method ?? "GET",
    headers: { host: upstream },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await answer.text()).replaceAll(upstream, request.headers.host ?? upstream);
  response.writeHead(answer.status, {
    "content-type": answer.headers.get("content-type") ?? "application/json",
    [GUARD_HEADER]: "1",
  });
  response.end(body);
}

function addressOf(upstreamOf: () => string): string | undefined {
  try {
    return upstreamOf();
  } catch {
    return undefined;
  }
}

function handle(
  upstreamOf: () => string,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const refusal = refusalOf(request);
  if (refusal !== undefined) {
    plain(response, refusal.status, refusal.message);
    return;
  }
  if (!(request.url ?? "").startsWith("/json")) {
    plain(response, 404, "only /json and the DevTools sockets are served");
    return;
  }
  const upstream = addressOf(upstreamOf);
  if (upstream === undefined) {
    plain(response, 502, "the browser's DevTools port is not known yet");
    return;
  }
  forwardJson(request, response, upstream).catch((error: unknown) => {
    plain(response, 502, `the browser did not answer: ${String(error)}`);
  });
}

const textOf = (data: RawData): string =>
  new TextDecoder().decode(Array.isArray(data) ? Buffer.concat(data) : data);

const closeCode = (code: number): number =>
  (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
    ? code
    : 1000;

function sendIfOpen(socket: WebSocket, data: string, binary: boolean): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary });
}

function relay(client: WebSocket, browser: WebSocket, gate: Gate): void {
  let queue = Promise.resolve();
  const end = (reason: string): void => {
    client.close(1008, reason.slice(0, 100));
    browser.close();
  };
  client.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      end("DevTools messages are text");
      return;
    }
    queue = queue
      .then(() => gate.admit(textOf(data)))
      .then((decision) => {
        if ("send" in decision) sendIfOpen(browser, decision.send, false);
        else if ("answer" in decision) sendIfOpen(client, decision.answer, false);
        else end(decision.close);
      })
      .catch((error: unknown) => {
        end(`the guard failed: ${String(error)}`.slice(0, 100));
      });
  });
  browser.on("message", (data: RawData, isBinary: boolean) => {
    const text = textOf(data);
    const out = isBinary ? text : gate.reply(text);
    if (out !== undefined) sendIfOpen(client, out, isBinary);
  });
  client.on("close", (code) => {
    browser.close(closeCode(code));
  });
  browser.on("close", (code) => {
    client.close(closeCode(code));
  });
  client.on("error", () => {
    browser.terminate();
  });
  browser.on("error", () => {
    client.terminate();
  });
}

function upgrade(
  sockets: WebSocketServer,
  typing: Typing,
  upstream: string,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const refusal = refusalOf(request);
  const found = SOCKET_PATH.exec(request.url ?? "");
  if (refusal !== undefined || found === null) {
    socket.end(`HTTP/1.1 ${String(refusal?.status ?? 404)} Refused\r\n${GUARD_HEADER}: 1\r\n\r\n`);
    return;
  }
  const browser = new WebSocket(`ws://${upstream}${request.url ?? ""}`, {
    maxPayload: MAX_FRAME,
    perMessageDeflate: false,
  });
  browser.once("error", () => {
    socket.end(`HTTP/1.1 502 Bad Gateway\r\n${GUARD_HEADER}: 1\r\n\r\n`);
  });
  browser.once("open", () => {
    sockets.handleUpgrade(request, socket, head, (client) => {
      relay(client, browser, new Gate(typing, found[1] === "page" ? found[2] : undefined));
    });
  });
}

export async function serve(
  host: string,
  port: number,
  upstreamOf: () => string,
  typing: Typing,
): Promise<Served> {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const server = createServer((request, response) => {
    handle(upstreamOf, request, response);
  });
  server.on("upgrade", (request, socket, head) => {
    const upstream = addressOf(upstreamOf);
    if (upstream === undefined) {
      socket.end(`HTTP/1.1 502 Bad Gateway\r\n${GUARD_HEADER}: 1\r\n\r\n`);
      return;
    }
    upgrade(sockets, typing, upstream, request, socket, head);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    server,
    close: async () => {
      for (const client of sockets.clients) client.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}

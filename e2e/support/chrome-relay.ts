import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { freePort } from "./chrome.ts";
import { HeldObjects } from "./held-objects.ts";
import { isRecord, optionalNumber, optionalString, type JsonRecord } from "./json.ts";

const textOf = (data: RawData): string =>
  new TextDecoder().decode(Array.isArray(data) ? Buffer.concat(data) : data);

const parsed = (text: string): JsonRecord | undefined => {
  try {
    const message: unknown = JSON.parse(text);
    return isRecord(message) ? message : undefined;
  } catch {
    return undefined;
  }
};

interface Link {
  readonly client: WebSocket;
  readonly forward: (text: string) => void;
  monitor: boolean;
  first: boolean;
}

const startsWatching = (message: JsonRecord): boolean =>
  optionalString(message, "method") === "Target.setDiscoverTargets";

function refuse(client: WebSocket, message: JsonRecord): void {
  const session = optionalString(message, "sessionId");
  client.send(
    JSON.stringify({
      id: optionalNumber(message, "id"),
      ...(session === undefined ? {} : { sessionId: session }),
      error: { code: -32000, message: "the relay refused this call" },
    }),
  );
}

export class ChromeRelay {
  readonly address: string;
  private readonly server: Server;
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly chrome: string;
  private readonly monitors = new Set<WebSocket>();
  private readonly frames = new Set<string>();
  private readonly held: (() => void)[] = [];
  private readonly failing = new Set<string>();
  private refused = 0;
  private readonly calls = new Map<string, number>();
  private readonly objects = new HeldObjects();
  private readonly lagging: (() => void)[] = [];
  private lagEvents = false;
  private blocking = false;
  private holding = false;

  private constructor(server: Server, port: number, chrome: string) {
    this.server = server;
    this.address = `127.0.0.1:${String(port)}`;
    this.chrome = chrome;
    server.on("request", (request, response) => {
      fetch(`http://${chrome}${request.url ?? "/json/version"}`)
        .then(async (answer) => {
          response.writeHead(answer.status, {
            "content-type": answer.headers.get("content-type") ?? "application/json",
          });
          response.end(await answer.text());
        })
        .catch(() => {
          response.writeHead(502).end();
        });
    });
    server.on("upgrade", (request, socket, head) => {
      this.sockets.handleUpgrade(request, socket, head, (client) => {
        this.pipe(client, request.url ?? "");
      });
    });
  }

  static async start(chrome: string): Promise<ChromeRelay> {
    const port = await freePort();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    return new ChromeRelay(server, port, chrome);
  }

  blindTheMonitor(): void {
    this.blocking = true;
    for (const monitor of this.monitors) monitor.terminate();
  }

  restoreTheMonitor(): void {
    this.blocking = false;
  }

  holdFrames(): void {
    this.holding = true;
  }

  heldFrameMessages(): number {
    return this.held.length;
  }

  releaseFrames(): void {
    this.holding = false;
    for (const send of this.held.splice(0)) send();
  }

  failTheMonitor(method: string): void {
    this.failing.add(method);
  }

  callsOf(method: string): number {
    return this.calls.get(method) ?? 0;
  }

  holdWorkerEvents(): void {
    this.lagEvents = true;
  }

  releaseWorkerEvents(): void {
    this.lagEvents = false;
    for (const send of this.lagging.splice(0)) send();
  }

  heldObjects(): number {
    return this.objects.count;
  }

  refusedCalls(): number {
    return this.refused;
  }

  mendTheMonitor(): void {
    this.failing.clear();
  }

  async stop(): Promise<void> {
    for (const client of this.sockets.clients) client.terminate();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }

  private failsNow(message: JsonRecord): boolean {
    const method = optionalString(message, "method");
    return method !== undefined && this.failing.has(method);
  }

  private observe(text: string): void {
    const message = parsed(text);
    if (message === undefined) return;
    this.objects.answered(message);
    this.noteFrame(message);
  }

  private noteFrame(message: JsonRecord): void {
    if (optionalString(message, "method") !== "Target.attachedToTarget") return;
    const params = message["params"];
    if (!isRecord(params)) return;
    const info = params["targetInfo"];
    const session = optionalString(params, "sessionId");
    if (isRecord(info) && optionalString(info, "type") === "iframe" && session !== undefined)
      this.frames.add(session);
  }

  private fromClient(link: Link, text: string): void {
    const message = parsed(text);
    const opening = link.first;
    link.first = false;
    if (opening && message !== undefined && startsWatching(message)) {
      if (this.blocking) {
        link.client.terminate();
        return;
      }
      link.monitor = true;
      this.monitors.add(link.client);
    }
    if (!link.monitor || message === undefined) {
      link.forward(text);
      return;
    }
    this.objects.sent(message);
    const method = optionalString(message, "method");
    if (method !== undefined) this.calls.set(method, this.callsOf(method) + 1);
    if (this.failsNow(message)) {
      this.refused++;
      refuse(link.client, message);
      return;
    }
    if (this.holdsBack(message))
      this.held.push(() => {
        link.forward(text);
      });
    else link.forward(text);
  }

  private holdsBack(message: JsonRecord): boolean {
    const session = optionalString(message, "sessionId");
    return this.holding && session !== undefined && this.frames.has(session);
  }

  private pipe(client: WebSocket, path: string): void {
    const browser = new WebSocket(`ws://${this.chrome}${path}`, { perMessageDeflate: false });
    const backlog: string[] = [];
    const link: Link = {
      client,
      monitor: false,
      first: true,
      forward: (text) => {
        if (browser.readyState === WebSocket.OPEN) browser.send(text);
        else backlog.push(text);
      },
    };
    client.on("message", (data: RawData) => {
      this.fromClient(link, textOf(data));
    });
    browser.on("open", () => {
      for (const text of backlog) browser.send(text);
    });
    browser.on("message", (data: RawData) => {
      const text = textOf(data);
      if (link.monitor) this.observe(text);
      const deliver = (): void => {
        if (client.readyState === WebSocket.OPEN) client.send(text);
      };
      if (this.lagEvents && !link.monitor && !text.startsWith('{"id":')) this.lagging.push(deliver);
      else deliver();
    });
    client.on("close", () => {
      this.monitors.delete(client);
      browser.terminate();
    });
    browser.on("close", () => {
      client.terminate();
    });
    client.on("error", () => {
      client.terminate();
    });
    browser.on("error", () => {
      browser.terminate();
    });
  }
}

import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { freePort } from "./chrome.ts";
import { isRecord, optionalString } from "./json.ts";

const textOf = (data: RawData): string =>
  new TextDecoder().decode(Array.isArray(data) ? Buffer.concat(data) : data);

const opensWatching = (text: string): boolean => {
  try {
    const message: unknown = JSON.parse(text);
    return isRecord(message) && optionalString(message, "method") === "Target.setDiscoverTargets";
  } catch {
    return false;
  }
};

export class ChromeRelay {
  readonly address: string;
  private readonly server: Server;
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly chrome: string;
  private readonly monitors = new Set<WebSocket>();
  private blocking = false;

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

  async stop(): Promise<void> {
    for (const client of this.sockets.clients) client.terminate();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }

  private pipe(client: WebSocket, path: string): void {
    const browser = new WebSocket(`ws://${this.chrome}${path}`, { perMessageDeflate: false });
    const backlog: string[] = [];
    let first = true;
    client.on("message", (data: RawData) => {
      const text = textOf(data);
      if (first && opensWatching(text)) {
        if (this.blocking) {
          client.terminate();
          return;
        }
        this.monitors.add(client);
      }
      first = false;
      if (browser.readyState === WebSocket.OPEN) browser.send(text);
      else backlog.push(text);
    });
    browser.on("open", () => {
      for (const text of backlog) browser.send(text);
    });
    browser.on("message", (data: RawData) => {
      if (client.readyState === WebSocket.OPEN) client.send(textOf(data));
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

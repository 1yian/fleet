import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { isRecord } from "./json.ts";

export interface MateRoute {
  readonly url: string;
  release(): void;
  stop(): Promise<void>;
}

const holds = (frame: string, key: string): boolean => {
  let message: unknown;
  try {
    message = JSON.parse(frame);
  } catch {
    return false;
  }
  return (
    isRecord(message) &&
    message["t"] === "call" &&
    message["op"] === "card.restart" &&
    isRecord(message["args"]) &&
    message["args"]["key"] === key
  );
};

const text = (data: RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(new Uint8Array(data)).toString("utf8");
};

export class RepeatProxy implements MateRoute {
  readonly url: string;
  private readonly server: Server;
  private readonly sockets: WebSocketServer;
  private readonly open: WebSocket[] = [];
  private released: () => void = () => undefined;
  private readonly releasedPromise = new Promise<void>((resolve) => {
    this.released = resolve;
  });
  private readonly upstream: string;
  private readonly key: string;
  private seen = 0;

  private constructor(server: Server, sockets: WebSocketServer, upstream: string, key: string) {
    this.server = server;
    this.sockets = sockets;
    this.upstream = upstream;
    this.key = key;
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("the proxy is not listening");
    this.url = `ws://127.0.0.1:${String(address.port)}/session`;
    sockets.on("connection", (client) => {
      this.relay(client);
    });
  }

  static async start(upstream: string, key: string): Promise<RepeatProxy> {
    const server = createServer();
    const sockets = new WebSocketServer({ server, path: "/session" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return new RepeatProxy(server, sockets, upstream, key);
  }

  release(): void {
    this.released();
  }

  private relay(client: WebSocket): void {
    const server = new WebSocket(this.upstream);
    this.open.push(client, server);
    const ready = new Promise<void>((resolve) => server.once("open", resolve));
    const forward = async (data: RawData, isBinary: boolean): Promise<void> => {
      await ready;
      const frame = isBinary ? "" : text(data);
      if (!isBinary && holds(frame, this.key)) {
        this.seen += 1;
        if (this.seen === 2) await this.releasedPromise;
      }
      if (server.readyState === WebSocket.OPEN) server.send(data, { binary: isBinary });
    };
    client.on("message", (data, isBinary) => {
      void forward(data, isBinary);
    });
    server.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    client.on("close", () => {
      server.close();
    });
    server.on("close", () => {
      client.close();
    });
    client.on("error", () => {
      server.terminate();
    });
    server.on("error", () => {
      client.terminate();
    });
  }

  async stop(): Promise<void> {
    this.released();
    for (const socket of this.open) socket.terminate();
    await new Promise<void>((resolve) => {
      this.sockets.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

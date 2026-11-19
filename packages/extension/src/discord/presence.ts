import { isRecord } from "../lane-config.ts";
import type { Discord } from "./discord.ts";
import { describeError, type Log } from "./log.ts";

const FIRST_RETRY_MS = 5_000;
const LAST_RETRY_MS = 120_000;
const STABLE_MS = 60_000;
const CLOSE_WAIT_MS = 2_000;
const NORMAL_CLOSE = 1000;
const ABANDONED_CLOSE = 4000;

const DISPATCH = 0;
const HEARTBEAT = 1;
const IDENTIFY = 2;
const RECONNECT = 7;
const INVALID_SESSION = 9;
const HELLO = 10;
const HEARTBEAT_ACK = 11;

interface Frame {
  readonly op: number;
  readonly data: unknown;
  readonly sequence: number | undefined;
  readonly event: string | undefined;
}

function gatewayAddress(url: string): string {
  const address = new URL(url);
  address.searchParams.set("v", "10");
  address.searchParams.set("encoding", "json");
  return address.href;
}

function frameOf(text: string): Frame | undefined {
  try {
    const body: unknown = JSON.parse(text);
    if (!isRecord(body) || typeof body["op"] !== "number") return undefined;
    const sequence = body["s"];
    const event = body["t"];
    return {
      op: body["op"],
      data: body["d"],
      sequence: typeof sequence === "number" ? sequence : undefined,
      event: typeof event === "string" ? event : undefined,
    };
  } catch {
    return undefined;
  }
}

export class Presence {
  private readonly discord: Discord;
  private readonly token: string;
  private readonly log: Log;
  private socket: WebSocket | undefined;
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryMs = FIRST_RETRY_MS;
  private readyAt: number | undefined;
  private sequence: number | null = null;
  private acknowledged = true;
  private stopped = false;

  constructor(discord: Discord, token: string, log: Log) {
    this.discord = discord;
    this.token = token;
    this.log = log;
  }

  start(): void {
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.heartbeat);
    const socket = this.socket;
    this.socket = undefined;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_WAIT_MS);
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close(NORMAL_CLOSE);
    });
  }

  private async connect(): Promise<void> {
    const url = await this.discord.gatewayUrl();
    if (this.stopped) return;
    if (url === undefined) {
      this.retryLater();
      return;
    }
    try {
      const socket = new WebSocket(gatewayAddress(url));
      this.socket = socket;
      this.sequence = null;
      this.acknowledged = true;
      socket.addEventListener("message", (event) => {
        this.receive(socket, String(event.data));
      });
      socket.addEventListener("close", (event) => {
        this.lost(socket, `the gateway closed the connection with code ${String(event.code)}`);
      });
    } catch (error) {
      this.log(`the gateway address is not usable: ${describeError(error)}`);
      this.retryLater();
    }
  }

  private lost(socket: WebSocket, why: string): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    clearTimeout(this.heartbeat);
    this.log(why);
    if (this.readyAt !== undefined && Date.now() - this.readyAt >= STABLE_MS)
      this.retryMs = FIRST_RETRY_MS;
    this.readyAt = undefined;
    this.retryLater();
  }

  private abandon(socket: WebSocket, why: string): void {
    this.lost(socket, why);
    socket.close(ABANDONED_CLOSE);
  }

  private retryLater(): void {
    this.retry = setTimeout(() => {
      void this.connect();
    }, this.retryMs);
    this.retry.unref();
    this.retryMs = Math.min(this.retryMs * 2, LAST_RETRY_MS);
  }

  private send(socket: WebSocket, frame: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  private receive(socket: WebSocket, text: string): void {
    if (socket !== this.socket) return;
    const frame = frameOf(text);
    if (frame === undefined) return;
    if (frame.sequence !== undefined) this.sequence = frame.sequence;
    this.handle(socket, frame);
  }

  private handle(socket: WebSocket, frame: Frame): void {
    if (frame.op === HELLO) this.hello(socket, frame.data);
    else if (frame.op === HEARTBEAT) this.send(socket, { op: HEARTBEAT, d: this.sequence });
    else if (frame.op === HEARTBEAT_ACK) this.acknowledged = true;
    else if (frame.op === RECONNECT) this.abandon(socket, "the gateway asked to reconnect");
    else if (frame.op === INVALID_SESSION) this.abandon(socket, "the gateway ended the session");
    else if (frame.op === DISPATCH && frame.event === "READY") this.readyAt = Date.now();
  }

  private hello(socket: WebSocket, data: unknown): void {
    const interval = isRecord(data) ? data["heartbeat_interval"] : undefined;
    if (typeof interval !== "number" || interval <= 0) {
      this.abandon(socket, "the gateway sent no heartbeat interval");
      return;
    }
    this.beatAfter(socket, interval, interval * Math.random());
    this.send(socket, {
      op: IDENTIFY,
      d: {
        token: this.token,
        intents: 0,
        properties: { os: process.platform, browser: "fleet", device: "fleet" },
        presence: { status: "online", since: null, activities: [], afk: false },
      },
    });
  }

  private beatAfter(socket: WebSocket, interval: number, wait: number): void {
    this.heartbeat = setTimeout(() => {
      if (!this.acknowledged) {
        this.abandon(socket, "the gateway stopped answering heartbeats");
        return;
      }
      this.acknowledged = false;
      this.send(socket, { op: HEARTBEAT, d: this.sequence });
      this.beatAfter(socket, interval, interval);
    }, wait);
    this.heartbeat.unref();
  }
}

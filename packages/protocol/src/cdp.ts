import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";

const Envelope = Type.Object({
  id: Type.Optional(Type.Integer()),
  method: Type.Optional(Type.String()),
  params: Type.Optional(Type.Unknown()),
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Object({ code: Type.Integer(), message: Type.String() })),
  sessionId: Type.Optional(Type.String()),
});

const VersionSchema = Type.Object({ webSocketDebuggerUrl: Type.String() });

const CONNECT_MS = 10_000;
const CALL_MS = 30_000;

export interface CdpEvent {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId: string | undefined;
}

type Listener = (event: CdpEvent) => void;

interface Pending {
  readonly method: string;
  readonly settle: (outcome: { ok: true; value: unknown } | { ok: false; error: Error }) => void;
}

export function parseCdp<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
  if (Value.Check(schema, value)) return value;
  throw new Error(`${what} is not what the browser should have sent`);
}

export async function debuggerUrl(endpoint: string, timeoutMs = CONNECT_MS): Promise<string> {
  const base = new URL(endpoint);
  if (base.protocol === "ws:" || base.protocol === "wss:") return base.toString();
  if (base.protocol !== "http:" && base.protocol !== "https:")
    throw new Error(`the browser endpoint ${endpoint} must be an http(s) or ws(s) URL`);
  const response = await fetch(new URL("/json/version", base), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`${base.host} answered /json/version with ${String(response.status)}`);
  const found = new URL(
    parseCdp(VersionSchema, await response.json(), "/json/version").webSocketDebuggerUrl,
  );
  found.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  found.host = base.host;
  return found.toString();
}

export class Cdp {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<Listener>();
  private readonly closers = new Set<() => void>();
  private ended = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      try {
        this.receive(String(event.data));
      } catch {
        this.close();
      }
    });
    socket.addEventListener("close", () => {
      this.end("the browser connection closed");
    });
  }

  static async connect(endpoint: string, timeoutMs = CONNECT_MS): Promise<Cdp> {
    const socket = new WebSocket(await debuggerUrl(endpoint, timeoutMs));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`the browser did not accept a connection within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("the browser refused the connection"));
      });
    });
    return new Cdp(socket);
  }

  get open(): boolean {
    return !this.ended;
  }

  onClose(closer: () => void): void {
    this.closers.add(closer);
  }

  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  send(
    method: string,
    params: unknown = {},
    options: { sessionId?: string | undefined; timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error("the browser connection is closed"));
    const id = this.nextId++;
    const { sessionId, timeoutMs = CALL_MS } = options;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        settle: (outcome) => {
          clearTimeout(timer);
          if (outcome.ok) resolve(outcome.value);
          else reject(outcome.error);
        },
      });
      const message =
        sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
      this.socket.send(JSON.stringify(message));
    });
  }

  close(): void {
    this.end("the browser connection was closed");
    this.socket.close();
  }

  private receive(text: string): void {
    const message = parseCdp(Envelope, JSON.parse(text), "a message");
    if (message.id !== undefined) {
      const waiting = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error !== undefined)
        waiting?.settle({
          ok: false,
          error: new Error(`${waiting.method}: ${message.error.message}`),
        });
      else waiting?.settle({ ok: true, value: message.result });
    } else if (message.method !== undefined) {
      const event = {
        method: message.method,
        params: message.params,
        sessionId: message.sessionId,
      };
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          continue;
        }
      }
    }
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiting of this.pending.values())
      waiting.settle({ ok: false, error: new Error(reason) });
    this.pending.clear();
    for (const closer of this.closers) closer();
  }
}

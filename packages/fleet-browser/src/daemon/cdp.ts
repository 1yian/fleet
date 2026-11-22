import WebSocket from "ws";

export type CdpEventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

export class CdpError extends Error {
  readonly code: number;
  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message}`);
    this.code = code;
  }
}

export class CdpClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<CdpEventHandler>>();
  private readonly closeHandlers = new Set<() => void>();
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", () => this.onClose());
    ws.on("error", () => this.onClose());
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      ws.once("open", () => resolve(new CdpClient(ws)));
      ws.once("error", (error) => reject(error));
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`cdp connection closed before ${method}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      const message: Record<string, unknown> = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.ws.send(JSON.stringify(message), (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  on(event: string, handler: CdpEventHandler): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  onClosed(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(text: string): void {
    const message = JSON.parse(text) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: unknown;
      error?: { code: number; message: string };
    };
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(new CdpError(pending.method, message.error.code, message.error.message));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method) {
      for (const handler of this.handlers.get(message.method) ?? [])
        handler(message.params ?? {}, message.sessionId);
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending)
      pending.reject(new Error(`cdp connection closed during ${pending.method}`));
    this.pending.clear();
    for (const handler of this.closeHandlers) handler();
  }
}

import {
  check,
  CLOSE,
  OPS,
  parseServerMessage,
  type OpResult,
  type ClientMessage,
  type OpName,
  type ServerMessage,
  type Maintenance,
} from "@fleet/protocol";

export type Push = Extract<ServerMessage, { t: "entry" }>;
type Result = Extract<ServerMessage, { t: "result" }>;

const MAX_BACKOFF_MS = 10_000;
const MAX_CLOSE_REASON = 100;

function stopsForGood(code: number): boolean {
  return code === CLOSE.notLive || code === CLOSE.superseded;
}

function checkResult<N extends OpName>(op: N, value: unknown): OpResult<N>;
function checkResult(op: OpName, value: unknown): unknown {
  return check(OPS[op].result, value);
}

const unreadableResult = (op: OpName, error: unknown): string =>
  `cardd's answer to ${op} cannot be read by this session (${error instanceof Error ? error.message : String(error)}). This session runs other code than cardd, most likely loaded before an update: restart this session so it loads the current code (main: lane(<lane>, "restart")).`;

export interface LinkOptions {
  readonly url: string;
  readonly token: string;
  readonly inFile: () => number[];
  readonly process?: string;
  readonly running?: () => boolean;
  readonly onPush: (push: Push) => void;
  readonly onConnect: () => void;
  readonly onMaintenance?: (request: Maintenance) => void;
  readonly onUnreadable: (error: string) => void;
  readonly onUnreadableResult: () => void;
}

export class Link {
  private socket: WebSocket | undefined;
  private connected = false;
  private stopped = false;
  private backoff = 250;
  private latest: "running" | "idle" | "waiting" | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, (result: Result) => void>();
  private readonly untold: ClientMessage[] = [];
  private readonly options: LinkOptions;
  private announced = false;

  constructor(options: LinkOptions) {
    this.options = options;
  }

  start(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      const { process: id } = this.options;
      const hello = {
        t: "hello" as const,
        token: this.options.token,
        inFile: this.options.inFile(),
        maintenance: this.options.onMaintenance !== undefined,
        running: this.options.running?.() === true,
        ...(id === undefined ? {} : { process: id }),
        ...(this.announced ? {} : { started: true }),
      };
      this.send(hello);
    });
    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = parseServerMessage(String(event.data));
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        this.options.onUnreadable(why);
        socket.close(CLOSE.unreadable, why.slice(0, MAX_CLOSE_REASON));
        return;
      }
      this.receive(message);
    });
    socket.addEventListener("close", (event) => {
      this.connected = false;
      this.failPending("cardd closed the connection");
      if (stopsForGood(event.code)) this.stopped = true;
      if (this.stopped) return;
      setTimeout(() => {
        this.start();
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close(1000);
  }

  call<N extends OpName>(op: N, args: unknown, deadlineMs?: number): Promise<OpResult<N>> {
    if (!this.connected)
      return Promise.reject(new Error("cardd is unreachable; try again shortly"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        deadlineMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error("cardd did not answer in time"));
            }, deadlineMs);
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        if (!result.ok) reject(new Error(result.error));
        else
          try {
            resolve(checkResult(op, result.value));
          } catch (error) {
            this.options.onUnreadableResult();
            reject(new Error(unreadableResult(op, error), { cause: error }));
          }
      });
      this.send({ t: "call", id, op, args });
    });
  }

  read(entry: number): void {
    this.tell({ t: "read", entry });
  }

  ack(entry: number): void {
    this.tell({ t: "ack", entry });
  }

  private tell(message: ClientMessage): void {
    if (this.connected) this.send(message);
    else this.untold.push(message);
  }

  activity(state: "running" | "idle" | "waiting", progress = false): void {
    this.latest = state;
    if (this.connected) this.send({ t: "activity", state, ...(progress ? { progress } : {}) });
  }

  private send(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private receive(message: ServerMessage): void {
    if (this.stopped && (message.t === "entry" || message.t === "maintenance")) return;
    if (message.t === "welcome") this.welcomed();
    else if (message.t === "entry") this.options.onPush(message);
    else if (message.t === "maintenance") this.options.onMaintenance?.(message.request);
    else {
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    }
  }

  private welcomed(): void {
    this.connected = true;
    this.announced = true;
    this.backoff = 250;
    for (const message of this.untold.splice(0)) this.send(message);
    if (this.latest !== undefined) this.send({ t: "activity", state: this.latest });
    this.options.onConnect();
  }

  private failPending(error: string): void {
    for (const [id, settle] of this.pending) settle({ t: "result", id, ok: false, error });
    this.pending.clear();
  }
}

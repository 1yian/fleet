import {
  check,
  OPS,
  parseServerMessage,
  type OpResult,
  type ClientMessage,
  type OpName,
  type ServerMessage,
} from "@fleet/protocol";

type Push = Extract<ServerMessage, { t: "entry" }>;
type Result = Extract<ServerMessage, { t: "result" }>;

const CLOSE_NOT_LIVE = 4001;
const CLOSE_UNREADABLE = 4003;
const MAX_BACKOFF_MS = 10_000;

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
  readonly onPush: (push: Push) => void;
  readonly onConnect: () => void;
  readonly onUnreadable: (error: string) => void;
}

export class Link {
  private socket: WebSocket | undefined;
  private connected = false;
  private stopped = false;
  private backoff = 250;
  private nextId = 1;
  private readonly pending = new Map<number, (result: Result) => void>();
  private readonly untoldAcks = new Set<number>();
  private readonly options: LinkOptions;

  constructor(options: LinkOptions) {
    this.options = options;
  }

  start(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.send({ t: "hello", token: this.options.token, inFile: this.options.inFile() });
    });
    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = parseServerMessage(String(event.data));
      } catch (error) {
        this.options.onUnreadable(error instanceof Error ? error.message : String(error));
        socket.close(CLOSE_UNREADABLE, "this session cannot read a message from cardd");
        return;
      }
      this.receive(message);
    });
    socket.addEventListener("close", (event) => {
      this.connected = false;
      this.failPending("cardd closed the connection");
      if (event.code === CLOSE_NOT_LIVE) this.stopped = true;
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

  call<N extends OpName>(op: N, args: unknown): Promise<OpResult<N>> {
    if (!this.connected)
      return Promise.reject(new Error("cardd is unreachable; try again shortly"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (result) => {
        if (!result.ok) reject(new Error(result.error));
        else
          try {
            resolve(checkResult(op, result.value));
          } catch (error) {
            reject(new Error(unreadableResult(op, error), { cause: error }));
          }
      });
      this.send({ t: "call", id, op, args });
    });
  }

  ack(entry: number): void {
    if (this.connected) this.send({ t: "ack", entry });
    else this.untoldAcks.add(entry);
  }

  defer(entry: number): void {
    if (this.connected) this.send({ t: "defer", entry });
  }

  activity(state: "running" | "idle" | "waiting"): void {
    if (this.connected) this.send({ t: "activity", state });
  }

  private send(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private receive(message: ServerMessage): void {
    if (message.t === "welcome") {
      this.connected = true;
      this.backoff = 250;
      for (const entry of this.untoldAcks) this.send({ t: "ack", entry });
      this.untoldAcks.clear();
      this.options.onConnect();
    } else if (message.t === "entry") this.options.onPush(message);
    else {
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    }
  }

  private failPending(error: string): void {
    for (const [id, settle] of this.pending) settle({ t: "result", id, ok: false, error });
    this.pending.clear();
  }
}

import { createConnection, createServer, type Server, type Socket } from "node:net";
import { optionalString, parseRecord } from "./json.ts";

const UPGRADE = /\r\nupgrade: *websocket/i;
const TEXT_FRAME = 1;

interface Waiting {
  readonly frame: Buffer;
  readonly upstream: Socket;
}

interface Wire {
  pending: Buffer;
  upgraded: boolean;
}

function headSize(bytes: Buffer): number | undefined {
  const end = bytes.indexOf("\r\n\r\n");
  return end < 0 ? undefined : end + 4;
}

function lengthsOf(bytes: Buffer): { header: number; payload: number } | undefined {
  const second = bytes[1];
  if (second === undefined) return undefined;
  const marked = second & 0x7f;
  const extra = marked === 126 ? 2 : marked === 127 ? 8 : 0;
  if (bytes.length < 2 + extra) return undefined;
  const payload =
    extra === 0 ? marked : extra === 2 ? bytes.readUInt16BE(2) : Number(bytes.readBigUInt64BE(2));
  return { header: 2 + extra + 4, payload };
}

function frameSize(bytes: Buffer): number | undefined {
  const lengths = lengthsOf(bytes);
  if (lengths === undefined) return undefined;
  const size = lengths.header + lengths.payload;
  return bytes.length < size ? undefined : size;
}

function methodOf(frame: Buffer): string | undefined {
  const first = frame[0];
  const lengths = lengthsOf(frame);
  if (first === undefined || lengths === undefined || (first & 0x0f) !== TEXT_FRAME)
    return undefined;
  const mask = frame.subarray(lengths.header - 4, lengths.header);
  const text = Buffer.from(
    frame.subarray(lengths.header).map((byte, index) => byte ^ (mask[index % 4] ?? 0)),
  );
  return optionalString(parseRecord(text.toString("utf8")), "method");
}

export class CdpGate {
  port = 0;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly seen = new Map<string, number>();
  private readonly waiting: Waiting[] = [];
  private readonly holds: { readonly method: string; times: number }[] = [];

  private constructor(target: number) {
    this.server = createServer((client) => {
      this.attach(client, createConnection({ port: target, host: "127.0.0.1" }));
    });
  }

  static async start(target: number): Promise<CdpGate> {
    const gate = new CdpGate(target);
    await new Promise<void>((resolve) => gate.server.listen(0, "127.0.0.1", resolve));
    const address = gate.server.address();
    if (address === null || typeof address === "string") throw new Error("the gate has no port");
    gate.port = address.port;
    return gate;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  private attach(client: Socket, upstream: Socket): void {
    const wire: Wire = { pending: Buffer.alloc(0), upgraded: false };
    for (const socket of [client, upstream]) {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => socket.destroy());
    }
    client.on("data", (chunk: Buffer) => {
      wire.pending = Buffer.concat([wire.pending, chunk]);
      this.forward(wire, upstream);
    });
    client.on("end", () => upstream.end());
    upstream.pipe(client);
  }

  private forward(wire: Wire, upstream: Socket): void {
    for (;;) {
      const size = wire.upgraded ? frameSize(wire.pending) : headSize(wire.pending);
      if (size === undefined) return;
      const piece = wire.pending.subarray(0, size);
      wire.pending = wire.pending.subarray(size);
      if (wire.upgraded) this.pass(piece, upstream);
      else {
        wire.upgraded = UPGRADE.test(piece.toString("latin1"));
        upstream.write(piece);
      }
    }
  }

  private pass(frame: Buffer, upstream: Socket): void {
    const method = methodOf(frame);
    if (method !== undefined) this.seen.set(method, this.count(method) + 1);
    const hold = this.holds.find((each) => each.method === method && each.times > 0);
    if (hold === undefined) upstream.write(frame);
    else {
      hold.times -= 1;
      this.waiting.push({ frame, upstream });
    }
  }

  hold(method: string, times: number): void {
    this.holds.push({ method, times });
  }

  holding(): number {
    return this.waiting.length;
  }

  count(method: string): number {
    return this.seen.get(method) ?? 0;
  }

  release(): void {
    const next = this.waiting.shift();
    if (next !== undefined && !next.upstream.destroyed) next.upstream.write(next.frame);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

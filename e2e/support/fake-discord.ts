import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { poll } from "./harness.ts";
import { isRecord, parseRecord } from "./json.ts";

export interface Posted {
  readonly content: string;
  readonly files: readonly { readonly name: string; readonly bytes: Buffer }[];
}

export interface Said {
  readonly author: string;
  readonly content: string;
  readonly flags?: number;
  readonly attachments?: readonly { readonly name: string; readonly bytes: Buffer }[];
}

export interface Transcription {
  readonly authorization: string;
  readonly model: string;
  readonly fileName: string;
  readonly bytes: Buffer;
}

interface Stored {
  readonly id: bigint;
  readonly body: Record<string, unknown>;
}

const FIRST_ID = 1_100_000_000_000_000_000n;

function readBytes(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

async function filesOf(form: FormData): Promise<Posted["files"]> {
  const found: { name: string; bytes: Buffer }[] = [];
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string" && key.startsWith("files"))
      found.push({ name: value.name, bytes: Buffer.from(await value.arrayBuffer()) });
  }
  return found;
}

function textField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export class FakeDiscord {
  readonly bot: string;
  readonly channel: string;
  readonly guild: string;
  readonly token: string;
  readonly groqKey: string;
  readonly posts: Posted[] = [];
  readonly transcriptions: Transcription[] = [];
  requests = 0;
  typings = 0;
  rejected = 0;
  transcript = "";
  private nextId = FIRST_ID;
  private readonly stored: Stored[] = [];
  private readonly served = new Map<string, Buffer>();
  private rateLimits: number[] = [];
  private readonly server: Server;
  private origin = "";

  private constructor(
    server: Server,
    ids: { bot: string; channel: string; guild: string; token: string; groqKey: string },
  ) {
    this.server = server;
    this.bot = ids.bot;
    this.channel = ids.channel;
    this.guild = ids.guild;
    this.token = ids.token;
    this.groqKey = ids.groqKey;
  }

  static async start(
    ids: { bot: string; channel: string; guild: string; token: string; groqKey?: string } = {
      bot: "1200000000000000001",
      channel: "1200000000000000002",
      guild: "1200000000000000003",
      token: "test-bot-token",
    },
  ): Promise<FakeDiscord> {
    const server = createServer();
    const fake = new FakeDiscord(server, { groqKey: "test-groq-key", ...ids });
    server.on("request", (request, response) => {
      void fake.answer(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === "string") throw new Error("no server address");
    fake.origin = `http://127.0.0.1:${String(address.port)}`;
    return fake;
  }

  get apiUrl(): string {
    return `${this.origin}/api/v10`;
  }

  get groqUrl(): string {
    return `${this.origin}/groq/openai/v1`;
  }

  say(message: Said): string {
    const id = this.nextId++;
    const attachments = (message.attachments ?? []).map((file, index) => {
      const path = `/files/${String(id)}-${String(index)}-${encodeURIComponent(file.name)}`;
      this.served.set(path, file.bytes);
      return {
        url: `${this.origin}${path}`,
        filename: file.name,
        ...(message.flags === undefined ? {} : { waveform: "AAAA" }),
      };
    });
    this.stored.push({
      id,
      body: {
        id: String(id),
        content: message.content,
        author: { id: message.author },
        attachments,
        ...(message.flags === undefined ? {} : { flags: message.flags }),
      },
    });
    return String(id);
  }

  limitNextPost(retryAfterSeconds: number): void {
    this.rateLimits.push(retryAfterSeconds);
  }

  async waitForPost(match: (post: Posted) => boolean, what: string): Promise<Posted> {
    return poll(() => this.posts.find(match), what);
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.requests++;
    const url = new URL(request.url ?? "/", this.origin);
    const bytes = await readBytes(request);
    const send = (status: number, body?: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (url.pathname.startsWith("/files/")) {
      const file = this.served.get(url.pathname);
      if (file === undefined) send(404);
      else response.writeHead(200).end(file);
      return;
    }
    if (url.pathname === "/groq/openai/v1/audio/transcriptions") {
      await this.transcribe(request, bytes, response);
      return;
    }
    if (request.headers.authorization !== `Bot ${this.token}`) {
      this.rejected++;
      send(401, { message: "401: Unauthorized" });
      return;
    }
    await this.route(request, url, bytes, send);
  }

  private async transcribe(
    request: IncomingMessage,
    bytes: Buffer,
    response: ServerResponse,
  ): Promise<void> {
    const authorization = String(request.headers.authorization);
    if (authorization !== `Bearer ${this.groqKey}`) {
      response.writeHead(401).end();
      return;
    }
    const form = await new Request("http://fake/", {
      method: "POST",
      headers: { "content-type": String(request.headers["content-type"]) },
      body: new Uint8Array(bytes),
    }).formData();
    const file = form.get("file");
    if (file === null || typeof file === "string") {
      response.writeHead(400).end();
      return;
    }
    this.transcriptions.push({
      authorization,
      model: textField(form, "model"),
      fileName: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    response.writeHead(200, { "content-type": "text/plain" }).end(this.transcript);
  }

  private async route(
    request: IncomingMessage,
    url: URL,
    bytes: Buffer,
    send: (status: number, body?: unknown) => void,
  ): Promise<void> {
    const channel = `/api/v10/channels/${this.channel}`;
    if (url.pathname === "/api/v10/users/@me") send(200, { id: this.bot });
    else if (url.pathname === channel) send(200, { id: this.channel, guild_id: this.guild });
    else if (url.pathname === `${channel}/messages` && request.method === "GET")
      send(200, this.listed(url));
    else if (url.pathname === `${channel}/typing`) {
      this.typings++;
      send(204);
    } else if (url.pathname === `${channel}/messages` && request.method === "POST")
      await this.accept(request, bytes, send);
    else send(404, { message: "Unknown Channel" });
  }

  private listed(url: URL): unknown[] {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const after = url.searchParams.get("after");
    const all = [...this.stored].sort((a, b) => (a.id < b.id ? -1 : 1));
    const chosen =
      after === null
        ? all.slice(-limit)
        : all.filter((message) => message.id > BigInt(after)).slice(0, limit);
    return chosen.reverse().map((message) => message.body);
  }

  private async accept(
    request: IncomingMessage,
    bytes: Buffer,
    send: (status: number, body?: unknown) => void,
  ): Promise<void> {
    const limited = this.rateLimits.shift();
    if (limited !== undefined) {
      send(429, { message: "You are being rate limited.", retry_after: limited });
      return;
    }
    const type = String(request.headers["content-type"]);
    if (type.startsWith("multipart/form-data")) {
      const form = await new Request("http://fake/", {
        method: "POST",
        headers: { "content-type": type },
        body: new Uint8Array(bytes),
      }).formData();
      const payload = form.get("payload_json");
      const content = typeof payload === "string" ? parseRecord(payload)["content"] : undefined;
      this.record(typeof content === "string" ? content : "", await filesOf(form), send);
      return;
    }
    const body: unknown = JSON.parse(bytes.toString("utf8"));
    const content = isRecord(body) ? body["content"] : undefined;
    this.record(typeof content === "string" ? content : "", [], send);
  }

  private record(
    content: string,
    files: Posted["files"],
    send: (status: number, body?: unknown) => void,
  ): void {
    const id = this.nextId++;
    this.posts.push({ content, files });
    this.stored.push({
      id,
      body: { id: String(id), content, author: { id: this.bot }, attachments: [] },
    });
    send(200, { id: String(id) });
  }
}

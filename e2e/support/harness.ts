import { type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { stream, wireCall, type WireCall } from "./anthropic-wire.ts";
import { spawnGuarded } from "./guarded.ts";
import {
  isRecord,
  messageText,
  optionalNumber,
  optionalString,
  parseRecord,
  type JsonRecord,
} from "./json.ts";
import { tempDir } from "./run-root.ts";

export interface Turn {
  readonly role: string;
  readonly text: string;
}
export type Move = { readonly promptTokens?: number } & (
  | { readonly text: string; readonly thinking?: string }
  | { readonly texts: readonly string[]; readonly thinking?: string }
  | {
      readonly tool: string;
      readonly text?: string;
      readonly args?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
    }
);
export interface Failure {
  readonly fail: string;
}
type ModelHandler = (turns: Turn[]) => Move | Failure | Promise<Move | Failure>;

const PI_BIN = fileURLToPath(new URL("../../node_modules/.bin/pi", import.meta.url));
const SUPPORT = fileURLToPath(new URL(".", import.meta.url));
const WAIT_MS = 15_000;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      resolve(body);
    });
    request.on("error", reject);
  });
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : Buffer.from(data).toString("utf8");
}

function tryRecord(line: string): JsonRecord | undefined {
  try {
    return parseRecord(line);
  } catch {
    return undefined;
  }
}

function toTurns(body: JsonRecord): Turn[] {
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  return messages.filter(isRecord).map((message) => ({
    role: typeof message["role"] === "string" ? message["role"] : "",
    text: messageText(message),
  }));
}

export class Pi {
  private readonly child: ChildProcess;
  private readonly exited: Promise<void>;
  readonly responses: JsonRecord[] = [];
  readonly uiRequests: JsonRecord[] = [];
  constructor(child: ChildProcess) {
    this.child = child;
    let buffered = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const record = tryRecord(line);
        if (record?.["type"] === "response") this.responses.push(record);
        if (record?.["type"] === "extension_ui_request") this.uiRequests.push(record);
      }
    });
    this.exited = new Promise((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
  }

  async waitForUi(match: (request: JsonRecord) => boolean, what: string): Promise<JsonRecord> {
    return poll(() => this.uiRequests.find(match), what);
  }

  prompt(message: string): void {
    this.command({ type: "prompt", message });
  }

  compact(): void {
    this.command({ type: "compact" });
  }

  async compactResponse(): Promise<JsonRecord> {
    const deadline = Date.now() + WAIT_MS * 2;
    for (;;) {
      const found = this.responses.find((record) => record["command"] === "compact");
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error("no response to the compact command");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  abort(): void {
    this.command({ type: "abort" });
  }

  async kill(): Promise<void> {
    this.child.kill("SIGKILL");
    await this.exited;
  }

  private command(record: JsonRecord): void {
    this.child.stdin?.write(`${JSON.stringify(record)}\n`);
  }
}

export class Harness {
  readonly dir = tempDir("fleet-e2e-");
  readonly calls: Turn[][] = [];
  readonly wire: WireCall[] = [];
  private readonly agentCalls = new Map<string, Turn[][]>();
  private readonly agentModels = new Map<string, string[]>();
  readonly events: JsonRecord[] = [];
  private readonly handlers = new Map<string, ModelHandler[]>();
  private readonly pis: Pi[] = [];
  private probe: WebSocket | undefined;
  private url = "";
  private readonly server: Server;
  private readonly sockets: WebSocketServer;

  private constructor(server: Server, sockets: WebSocketServer) {
    this.server = server;
    this.sockets = sockets;
  }

  static async start(): Promise<Harness> {
    const server = createServer();
    const harness = new Harness(server, new WebSocketServer({ server, path: "/probe" }));
    server.on("request", (request, response) => {
      if (request.method === "POST" && request.url?.startsWith("/anthropic/v1/messages") === true) {
        void harness.answerWire(request, response);
        return;
      }
      if (request.method !== "POST" || request.url !== "/model") {
        response.writeHead(404).end();
        return;
      }
      void harness.answerModel(request, response);
    });

    harness.sockets.on("connection", (socket) => {
      harness.probe = socket;
      socket.on("message", (data) => harness.events.push(parseRecord(rawText(data))));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === "string") throw new Error("no server address");
    harness.url = `http://127.0.0.1:${String(address.port)}`;
    return harness;
  }

  onModel(handler: ModelHandler, agent = "default"): void {
    this.handlers.set(agent, [...(this.handlers.get(agent) ?? []), handler]);
  }

  callsOf(agent: string): Turn[][] {
    return agent === "default" ? this.calls : (this.agentCalls.get(agent) ?? []);
  }

  modelsOf(agent: string): string[] {
    return this.agentModels.get(agent) ?? [];
  }

  piArgs(builtinTools = false): string[] {
    return [
      ["--offline", "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates"],
      [
        "--no-themes",
        "--no-context-files",
        "--no-mcp",
        ...(builtinTools ? [] : ["--no-builtin-tools"]),
      ],
      ["-e", join(SUPPORT, "fake-model.ts"), "--provider", "fake", "--model", "scripted"],
      ["--session-dir", join(this.dir, "sessions")],
    ].flat();
  }

  piEnv(agent: string): Record<string, string> {
    return {
      PI_CODING_AGENT_DIR: join(this.dir, "agent"),
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      FLEET_CONTROL_URL: this.url,
      FLEET_FAKE_AGENT: agent,
    };
  }

  startPi(
    sessionId: string,
    env: Record<string, string> = {},
    extensions: readonly string[] = [],
    modelArgs: readonly string[] = [],
    builtinTools = false,
  ): Pi {
    const agentDir = join(this.dir, "agent");
    const workDir = join(this.dir, "work");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    const args = [
      ["--mode", "rpc", ...this.piArgs(builtinTools), "-e", join(SUPPORT, "probe.ts")],
      extensions.flatMap((path) => ["-e", path]),
      modelArgs,
      ["--session-id", sessionId],
    ].flat();
    const child = spawnGuarded(PI_BIN, args, {
      cwd: workDir,
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        ...env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        FLEET_CONTROL_URL: this.url,
      },
    });
    const pi = new Pi(child);
    this.pis.push(pi);
    return pi;
  }

  send(id: number, mode: "steer" | "followUp", text: string): void {
    this.probe?.send(JSON.stringify({ type: "send", id, mode, text }));
  }

  releaseTool(): void {
    this.probe?.send(JSON.stringify({ type: "release" }));
  }

  async waitFor(match: (event: JsonRecord) => boolean, what: string): Promise<JsonRecord> {
    return poll(() => this.events.find(match), what);
  }

  async waitForNth(
    match: (event: JsonRecord) => boolean,
    n: number,
    what: string,
  ): Promise<JsonRecord> {
    return poll(() => this.events.filter(match)[n - 1], what);
  }

  async waitForWire(match: (call: WireCall) => boolean, what: string): Promise<WireCall> {
    return poll(() => this.wire.find(match), what);
  }

  async waitForCall(index: number, agent = "default", waitMs = WAIT_MS): Promise<Turn[]> {
    try {
      return await poll(() => this.callsOf(agent)[index], `model call ${String(index)}`, waitMs);
    } catch (error) {
      const calls = this.callsOf(agent);
      const last = (calls.at(-1) ?? [])
        .slice(-2)
        .map((turn) => `${turn.role}: ${turn.text.slice(0, 300)}`);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message} of ${agent}; it made ${String(calls.length)}, the last ending ${last.join(" | ")}`,
        { cause: error },
      );
    }
  }

  static fleetEntriesInFile(file: string): number[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(parseRecord)
      .filter((entry) => entry["type"] === "custom_message" && entry["customType"] === "fleet")
      .map((entry) =>
        isRecord(entry["details"]) ? optionalNumber(entry["details"], "entryId") : -2,
      )
      .filter((id) => id !== undefined);
  }

  async stop(): Promise<void> {
    await Promise.all(this.pis.map((pi) => pi.kill()));
    this.sockets.close();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private async answerModel(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const turns = toTurns(parseRecord(await readBody(request)));
    const header = request.headers["x-fake-agent"];
    const model = request.headers["x-fake-model"];
    const move = await this.scripted(
      typeof header === "string" ? header : "default",
      typeof model === "string" ? model : "unknown",
      turns,
    );
    if ("fail" in move) {
      response.writeHead(500, { "content-type": "text/plain" }).end(move.fail);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(move));
  }

  private async answerWire(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = parseRecord(await readBody(request));
    const call = wireCall(body);
    this.wire.push(call);
    const header = request.headers["x-fake-agent"];
    const agent =
      call.role === "worker" ? "worker" : typeof header === "string" ? header : "default";
    const move = call.warm
      ? { text: "warm" }
      : await this.scripted(agent, optionalString(body, "model") ?? "unknown", [...call.turns]);
    if ("fail" in move) {
      response.writeHead(500, { "content-type": "text/plain" }).end(move.fail);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" }).end(stream(move));
  }

  private async scripted(agent: string, model: string, turns: Turn[]): Promise<Move | Failure> {
    this.agentModels.set(agent, [...this.modelsOf(agent), model]);
    if (agent === "default") this.calls.push(turns);
    else this.agentCalls.set(agent, [...this.callsOf(agent), turns]);
    const handler = this.handlers.get(agent)?.shift() ?? (() => ({ text: "ok" }));
    return handler(turns);
  }
}

async function poll<T>(read: () => T | undefined, what: string, waitMs = WAIT_MS): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function gate(): { readonly open: () => void; readonly wait: Promise<void> } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { open, wait };
}

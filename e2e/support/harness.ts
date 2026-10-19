// Test harness: a control server for the fake model and the probe, and Pi
// processes in RPC mode with an isolated agent folder.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { isRecord, messageText, optionalNumber, parseRecord, type JsonRecord } from "./json.ts";

export interface Turn {
  readonly role: string;
  readonly text: string;
}
type Move =
  | { readonly text: string }
  | { readonly tool: string; readonly args?: Readonly<Record<string, string | number | boolean>> };
type ModelHandler = (turns: Turn[]) => Move | Promise<Move>;

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

function toTurns(body: JsonRecord): Turn[] {
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  return messages.filter(isRecord).map((message) => ({
    role: typeof message["role"] === "string" ? message["role"] : "",
    text: messageText(message),
  }));
}

/** One Pi process in RPC mode. */
export class Pi {
  /** Pi's RPC event stream (spec: docs/json.md in the Pi package). */
  readonly events: JsonRecord[] = [];
  private readonly child: ChildProcess;
  private readonly exited: Promise<void>;
  constructor(child: ChildProcess) {
    this.child = child;
    let buffer = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (buffer + chunk).split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") this.events.push(parseRecord(line));
    });
    this.exited = new Promise((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
  }

  prompt(message: string): void {
    this.command({ type: "prompt", message });
  }

  abort(): void {
    this.command({ type: "abort" });
  }

  async waitFor(match: (event: JsonRecord) => boolean, what: string): Promise<JsonRecord> {
    return poll(() => this.events.find(match), what);
  }

  /** Simulates a crash. */
  async kill(): Promise<void> {
    this.child.kill("SIGKILL");
    await this.exited;
  }

  private command(record: JsonRecord): void {
    this.child.stdin?.write(`${JSON.stringify(record)}\n`);
  }
}

export class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), "fleet-e2e-"));
  readonly calls: Turn[][] = [];
  readonly events: JsonRecord[] = [];
  private readonly handlers: ModelHandler[] = [];
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

  /** Queues the answer to the next model call. Unqueued calls answer "ok". */
  onModel(handler: ModelHandler): void {
    this.handlers.push(handler);
  }

  /** Starts Pi with the fake model and the probe, plus any extra extensions. */
  startPi(
    sessionId: string,
    env: Record<string, string> = {},
    extensions: readonly string[] = [],
  ): Pi {
    const agentDir = join(this.dir, "agent");
    const workDir = join(this.dir, "work");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    const args = [
      ["--mode", "rpc", "--offline", "--no-approve", "--no-extensions", "--no-skills"],
      ["--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp"],
      ["--no-builtin-tools", "-e", join(SUPPORT, "fake-model.ts"), "-e", join(SUPPORT, "probe.ts")],
      extensions.flatMap((path) => ["-e", path]),
      ["--provider", "fake", "--model", "scripted"],
      ["--session-dir", join(this.dir, "sessions"), "--session-id", sessionId],
    ].flat();
    const child = spawn(PI_BIN, args, {
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

  /** Asks the probe to send a fleet message. */
  send(id: number, mode: "steer" | "followUp", text: string): void {
    this.probe?.send(JSON.stringify({ type: "send", id, mode, text }));
  }

  releaseTool(): void {
    this.probe?.send(JSON.stringify({ type: "release" }));
  }

  async waitFor(match: (event: JsonRecord) => boolean, what: string): Promise<JsonRecord> {
    return poll(() => this.events.find(match), what);
  }

  /** Waits for the nth event (counting from 1) that matches. */
  async waitForNth(
    match: (event: JsonRecord) => boolean,
    n: number,
    what: string,
  ): Promise<JsonRecord> {
    return poll(() => this.events.filter(match)[n - 1], what);
  }

  async waitForCall(index: number): Promise<Turn[]> {
    return poll(() => this.calls[index], `model call ${String(index)}`);
  }

  /** The fleet entry IDs in a Pi session file, in file order. */
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
    this.calls.push(turns);
    const handler = this.handlers.shift() ?? (() => ({ text: "ok" }));
    const move = await handler(turns);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(move));
  }
}

async function poll<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A promise that the test resolves by hand, to hold a model call open. */
export function gate(): { readonly open: () => void; readonly wait: Promise<void> } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { open, wait };
}

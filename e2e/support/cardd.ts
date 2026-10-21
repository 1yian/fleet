import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  BoardSchema,
  check,
  parseServerMessage,
  ThreadSchema,
  type Board,
  type BoardAction,
  type Entry,
  type ServerMessage,
  type Thread,
} from "@fleet/protocol";

const MAIN = fileURLToPath(new URL("../../packages/cardd/src/main.ts", import.meta.url));
const WAIT_MS = 10_000;

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export class Cardd {
  readonly db = join(mkdtempSync(join(tmpdir(), "fleet-cardd-")), "cards.db");
  url = "";
  private child: ChildProcess | undefined;
  private readonly env: NodeJS.ProcessEnv;

  private readonly args: readonly string[];

  private constructor(env: NodeJS.ProcessEnv, args: readonly string[]) {
    this.env = { ...process.env, ...env };
    this.args = args;
  }

  static async start(
    env: Record<string, string> = {},
    args: readonly string[] = [],
    seed?: (db: string) => void,
  ): Promise<Cardd> {
    const cardd = new Cardd(env, args);
    seed?.(cardd.db);
    await cardd.boot();
    return cardd;
  }

  dashTokens(sessions: readonly string[]): void {
    for (let seed = 0; ; seed += 1) {
      const key = createHash("sha256").update(String(seed)).digest();
      const token = (session: string): string =>
        createHmac("sha256", key).update(session).digest("base64url");
      if (!sessions.every((session) => token(session).startsWith("-"))) continue;
      const db = new DatabaseSync(this.db);
      db.prepare("INSERT INTO secrets (name, value) VALUES ('token-key', ?)").run(key);
      db.close();
      return;
    }
  }

  addLane(name: string, parent?: string, home = `/homes/${name}`): string {
    const args = [MAIN, "lane", "add", name, "--db", this.db, "--home", home];
    return execFileSync("node", parent === undefined ? args : [...args, "--parent", parent], {
      encoding: "utf8",
    }).trim();
  }

  addProject(name: string, clones: Record<string, string> = {}): void {
    this.addProjectWithCloneArgs(
      name,
      Object.entries(clones).map(([host, path]) => `${host}=${path}`),
    );
  }

  addProjectWithCloneArgs(name: string, clones: readonly string[]): void {
    const args = [MAIN, "project", "add", name, "--db", this.db, "--delivery", "no-mistakes"];
    const cloneArgs = clones.flatMap((clone) => ["--clone", clone]);
    execFileSync("node", [...args, ...cloneArgs], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  yolo(project: string, on = true): string {
    const args = [MAIN, "project", "yolo", project, on ? "on" : "off", "--db", this.db];
    return execFileSync("node", args, { encoding: "utf8" }).trim();
  }

  async post(token: string, op: string, args: unknown): Promise<{ status: number; body: unknown }> {
    const response = await fetch(this.url.replace(/^ws/, "http").replace(/\/session$/, "/call"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ op, args }),
    });
    const body: unknown = await response.json();
    return { status: response.status, body };
  }

  private http(path: string): string {
    return this.url.replace(/^ws/, "http").replace(/\/session$/, path);
  }

  async board(): Promise<Board> {
    return check(BoardSchema, await (await fetch(this.http("/api/board"))).json());
  }

  async thread(card: number): Promise<Thread> {
    return check(ThreadSchema, await (await fetch(this.http(`/api/card/${String(card)}`))).json());
  }

  async act(card: number, action: BoardAction["action"]): Promise<number> {
    const revision = (await this.board()).cards.find((each) => each.id === card)?.revision ?? -1;
    const response = await fetch(this.http("/api/action"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ card, revision, action }),
    });
    return response.status;
  }

  async connect(token: string, inFile: readonly number[] = []): Promise<Session> {
    const session = new Session(new WebSocket(this.url));
    await session.opened;
    session.send({ t: "hello", token, inFile });
    await until(() => session.welcome ?? session.closeCode, "welcome or close");
    return session;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.boot(new URL(this.url.replace(/^ws/, "http")).port);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child?.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }

  private async boot(port = "0"): Promise<void> {
    const child = spawn(
      "node",
      [MAIN, "serve", "--db", this.db, "--listen", `127.0.0.1:${port}`, ...this.args],
      {
        stdio: ["ignore", "pipe", "inherit"],
        env: this.env,
      },
    );
    this.child = child;
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    this.url = await until(() => /listening on (\S+)/.exec(out)?.[1], "cardd to listen");
  }
}

type Outgoing =
  | { t: "hello"; token: string; inFile: readonly number[] }
  | { t: "ack"; entry: number }
  | { t: "activity"; state: "running" | "idle" | "waiting" }
  | { t: "call"; id: number; op: string; args: unknown };

export class Session {
  readonly entries: Extract<ServerMessage, { t: "entry" }>[] = [];
  readonly opened: Promise<void>;
  welcome: Extract<ServerMessage, { t: "welcome" }> | undefined;
  closeCode: number | undefined;
  private readonly socket: WebSocket;
  private readonly results = new Map<number, Extract<ServerMessage, { t: "result" }>>();
  private nextId = 1;

  constructor(socket: WebSocket) {
    this.socket = socket;
    this.opened = new Promise((resolve) => {
      socket.addEventListener("open", () => {
        resolve();
      });
    });
    socket.addEventListener("message", (event) => {
      this.receive(parseServerMessage(String(event.data)));
    });
    socket.addEventListener("close", (event) => (this.closeCode = event.code));
  }

  send(message: Outgoing): void {
    this.socket.send(JSON.stringify(message));
  }

  async call(op: string, args: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send({ t: "call", id, op, args });
    const result = await until(() => this.results.get(id) ?? this.closeCode, `the result of ${op}`);
    if (typeof result === "number") throw new Error(`the connection closed with ${String(result)}`);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  ack(entry: number): void {
    this.send({ t: "ack", entry });
  }

  async waitForEntries(count: number): Promise<Entry[]> {
    await until(
      () => (this.entries.length >= count ? true : undefined),
      `${String(count)} entries`,
    );
    return this.entries.map((push) => push.entry);
  }

  async waitForEntry(match: (entry: Entry) => boolean, what: string): Promise<Entry> {
    return until(() => this.entries.find((push) => match(push.entry))?.entry, what);
  }

  async close(): Promise<void> {
    this.socket.close(1000);
    await until(() => this.closeCode, "close");
  }

  private receive(message: ServerMessage): void {
    if (message.t === "welcome") this.welcome = message;
    else if (message.t === "entry") this.entries.push(message);
    else this.results.set(message.id, message);
  }
}

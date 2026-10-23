import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import {
  check,
  HttpCallSchema,
  isOpName,
  type HttpOutcome,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "@fleet/protocol";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { readPullRequests, runCheck } from "./check.ts";
import type { Timings } from "./timing.ts";
import { acknowledge, confirm, toPush } from "./deliveries.ts";
import { adoptMaintenance, pendingFor } from "./maintenance.ts";
import { adoptProcess } from "./incidents.ts";
import { performOp } from "./ops.ts";
import { fillRepo, projectsWithoutRepo, type Hosts } from "./pulls.ts";
import { sessionByToken, setSessionState, transaction, type Session } from "./store.ts";
import { Web } from "./web.ts";

const CLOSE_BAD_MESSAGE = 4000;
const CLOSE_NOT_LIVE = 4001;
const CLOSE_SUPERSEDED = 4002;

const EVERY_INTERFACE: ReadonlySet<string> = new Set(["0.0.0.0", "::", "::ffff:0.0.0.0"]);

class NotLive extends Error {}

function text(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : Buffer.from(data).toString("utf8");
}
const send = (socket: WebSocket, message: ServerMessage): void => {
  socket.send(JSON.stringify(message));
};
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

class Hub {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly db: DatabaseSync;
  private readonly timing: Timings;
  private readonly hosts: Hosts;
  private checking = false;
  private readonly reading = new Set<string>();
  readonly web: Web;

  constructor(db: DatabaseSync, timing: Timings, files: string | undefined, hosts: Hosts) {
    this.db = db;
    this.timing = timing;
    this.hosts = hosts;
    this.web = new Web(
      db,
      (session) => {
        this.flush(session, false);
      },
      files,
    );
  }

  fillRepos(): void {
    for (const project of projectsWithoutRepo(this.db)) {
      if (this.reading.has(project.name)) continue;
      this.reading.add(project.name);
      void fillRepo(this.db, this.hosts, project).finally(() => {
        this.reading.delete(project.name);
      });
    }
  }

  check(): void {
    this.fillRepos();
    if (this.checking) return;
    this.checking = true;
    void readPullRequests(this.db)
      .then((prs) => {
        const notify = transaction(this.db, () => runCheck(this.db, Date.now(), this.timing, prs));
        for (const recipient of notify) this.flush(recipient, false);
        if (notify.length > 0) this.web.changed();
      })
      .finally(() => {
        this.checking = false;
      });
  }

  async perform(session: Session, op: string, args: unknown): Promise<HttpOutcome> {
    try {
      if (!isOpName(op)) throw new Error(`unknown operation ${op}`);
      const done = await performOp(this.db, session, op, args, this.timing);
      for (const recipient of done.notify) this.flush(recipient, false);
      this.web.changed();
      return { ok: true, value: done.value };
    } catch (error) {
      return { ok: false, error: reason(error) };
    }
  }

  attach(socket: WebSocket): void {
    let token: string | undefined;
    let session: Session | undefined;
    const live = (): Session => {
      const current = token === undefined ? undefined : sessionByToken(this.db, token);
      if (!current?.live) throw new NotLive("the session is not live");
      return current;
    };
    const handle = (message: ClientMessage): void => {
      if (message.t === "hello") {
        session = this.hello(socket, message);
        token = session === undefined ? undefined : message.token;
      } else if (message.t === "ack") acknowledge(this.db, live().id, message.entry);
      else if (message.t === "activity") {
        if (setSessionState(this.db, live().id, message.state)) this.web.changed();
      } else {
        const id = message.id;
        void this.perform(live(), message.op, message.args).then((outcome) => {
          send(socket, { t: "result", id, ...outcome });
        });
      }
    };
    socket.on("message", (data) => {
      try {
        handle(parseClientMessage(text(data)));
      } catch (error) {
        const code =
          session === undefined || error instanceof NotLive ? CLOSE_NOT_LIVE : CLOSE_BAD_MESSAGE;
        socket.close(code, reason(error).slice(0, 120));
      }
    });
    socket.on("close", (code) => {
      if (session === undefined || this.sockets.get(session.id) !== socket) return;
      this.sockets.delete(session.id);
      if (setSessionState(this.db, session.id, code === 1000 ? "exited" : "lost"))
        this.web.changed();
    });
  }

  async answerHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, outcome: HttpOutcome): void => {
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(outcome));
    };
    if (request.method !== "POST" || request.url !== "/call") {
      await this.web.answer(request, response);
      return;
    }
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
    const session = token === undefined ? undefined : sessionByToken(this.db, token);
    if (!session?.live) {
      reply(401, { ok: false, error: "unknown token, or the attempt ended" });
      return;
    }
    try {
      const body = check(HttpCallSchema, JSON.parse(await readBody(request)));
      const outcome = await this.perform(session, body.op, body.args);
      reply(outcome.ok ? 200 : 400, outcome);
    } catch (error) {
      reply(400, { ok: false, error: reason(error) });
    }
  }

  private hello(
    socket: WebSocket,
    message: Extract<ClientMessage, { t: "hello" }>,
  ): Session | undefined {
    const session = sessionByToken(this.db, message.token);
    if (!session?.live) {
      socket.close(CLOSE_NOT_LIVE, "unknown token, or the attempt ended");
      return undefined;
    }
    this.sockets.get(session.id)?.close(CLOSE_SUPERSEDED, "a newer connection took over");
    this.sockets.set(session.id, socket);
    const { lowWater, reporters } = transaction(this.db, () => {
      setSessionState(this.db, session.id, "idle");
      adoptProcess(this.db, session.id, message.process);
      const told = adoptMaintenance(
        this.db,
        session.id,
        message.process,
        message.maintenance === true,
      );
      return { lowWater: confirm(this.db, session.id, message.inFile), reporters: told };
    });
    this.web.changed();
    send(socket, { t: "welcome", session: session.id, role: session.role, lowWater });
    this.flush(session.id, true);
    for (const reporter of new Set(reporters)) this.flush(reporter, false);
    return session;
  }

  private batching(): { now: number; window: number } {
    return { now: this.timing.wall(), window: this.timing.batch };
  }

  flush(session: string, atConnect: boolean): void {
    const socket = this.sockets.get(session);
    if (socket === undefined) return;
    for (const request of pendingFor(this.db, session)) send(socket, { t: "maintenance", request });
    for (const push of transaction(this.db, () =>
      toPush(this.db, session, atConnect, this.batching()),
    )) {
      send(socket, { t: "entry", ...push });
    }
  }
}

export async function serve(
  db: DatabaseSync,
  host: string,
  port: number,
  timing: Timings,
  {
    files,
    hostnames,
    hosts,
  }: { files?: string | undefined; hostnames: readonly string[]; hosts: Hosts },
): Promise<string> {
  db.prepare(
    "UPDATE sessions SET state = 'lost', last_seen = ? WHERE state IN ('idle', 'running', 'waiting')",
  ).run(Date.now());
  const hub = new Hub(db, timing, files, hosts);
  hub.fillRepos();
  setInterval(() => {
    hub.check();
  }, timing.every).unref();
  const server = createServer((request, response) => {
    void hub.answerHttp(request, response);
  });
  const sessions = new WebSocketServer({ noServer: true });
  const boards = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://cardd").pathname;
    const target =
      path === "/session"
        ? sessions
        : path === "/live" && hub.web.permits(request)
          ? boards
          : undefined;
    if (target === undefined) socket.destroy();
    else
      target.handleUpgrade(request, socket, head, (ws) => {
        if (target === sessions) hub.attach(ws);
        else hub.web.watch(ws);
      });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("the server has no address");
  if (EVERY_INTERFACE.has(address.address)) {
    server.close();
    throw new Error("cardd binds to the Tailscale address, never to every interface");
  }
  const name = host.includes(":") ? `[${host}]` : host;
  const withPort = (each: string): string =>
    /:\d+$/.test(each) ? each : `${each}:${String(address.port)}`;
  hub.web.allow([name, ...hostnames].map(withPort));
  return `ws://${name}:${String(address.port)}/session`;
}

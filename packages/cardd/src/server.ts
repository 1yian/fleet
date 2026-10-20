// One websocket per session (spec section 12.1), and POST /call for scripts.
// The first websocket message must be hello with the session token. Every
// later message re-checks that the session is still live, so an ended or
// replaced attempt loses access at once.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import {
  check,
  HttpCallSchema,
  isOpName,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "@fleet/protocol";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { acknowledge, confirm, toPush } from "./deliveries.ts";
import { runOp } from "./ops.ts";
import { timedCheck, type Timing } from "./timed.ts";
import { sessionByToken, setSessionState, transaction, type Session } from "./store.ts";

const CLOSE_BAD_MESSAGE = 4000;
const CLOSE_NOT_LIVE = 4001;
const CLOSE_SUPERSEDED = 4002;

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

/** The session's attempt ended or was replaced. The socket closes with CLOSE_NOT_LIVE. */
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
  private readonly timing: Timing;

  constructor(db: DatabaseSync, timing: Timing) {
    this.db = db;
    this.timing = timing;
  }

  /** One pass of the timed check (spec section 13). Pushes the findings it wrote. */
  check(): void {
    const notify = transaction(this.db, () => timedCheck(this.db, this.timing, Date.now()));
    for (const recipient of notify) this.flush(recipient, false);
  }

  /** Runs an operation, then pushes its new entries. Websocket calls and POST /call share it. */
  perform(session: Session, op: string, args: unknown): Outcome {
    try {
      if (!isOpName(op)) throw new Error(`unknown operation ${op}`);
      const done = transaction(this.db, () => runOp(this.db, session, op, args, this.timing));
      for (const recipient of done.notify) this.flush(recipient, false);
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
      else if (message.t === "activity") setSessionState(this.db, live().id, message.state);
      else
        send(socket, {
          t: "result",
          id: message.id,
          ...this.perform(live(), message.op, message.args),
        });
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
      setSessionState(this.db, session.id, code === 1000 ? "exited" : "lost");
    });
  }

  /** POST /call with `Authorization: Bearer <token>`: a script acts as that session. */
  async answerHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, outcome: Outcome): void => {
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(outcome));
    };
    if (request.method !== "POST" || request.url !== "/call") {
      reply(404, { ok: false, error: "not found" });
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
      const outcome = this.perform(session, body.op, body.args);
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
    const lowWater = transaction(this.db, () => {
      setSessionState(this.db, session.id, "idle");
      return confirm(this.db, session.id, message.inFile);
    });
    send(socket, { t: "welcome", session: session.id, role: session.role, lowWater });
    this.flush(session.id, true);
    return session;
  }

  private flush(session: string, atConnect: boolean): void {
    const socket = this.sockets.get(session);
    if (socket === undefined) return;
    for (const push of transaction(this.db, () => toPush(this.db, session, atConnect))) {
      send(socket, { t: "entry", ...push });
    }
  }
}

export async function serve(
  db: DatabaseSync,
  host: string,
  port: number,
  timing: Timing,
): Promise<string> {
  const hub = new Hub(db, timing);
  setInterval(() => {
    hub.check();
  }, timing.checkMs).unref();
  const server = createServer((request, response) => {
    void hub.answerHttp(request, response);
  });
  new WebSocketServer({ server, path: "/session" }).on("connection", (socket) => {
    hub.attach(socket);
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("the server has no address");
  return `ws://${host}:${String(address.port)}/session`;
}

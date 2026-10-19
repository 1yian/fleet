// One websocket per session (spec section 12.1). The first message must be
// hello with the session token. Every later message re-checks that the
// session is still live, so an ended or replaced attempt loses access at once.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import {
  isOpName,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "@fleet/protocol";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { acknowledge, confirm, toPush } from "./deliveries.ts";
import { runOp } from "./ops.ts";
import { sessionByToken, setSessionState, transaction, type Session } from "./store.ts";

const CLOSE_BAD_MESSAGE = 4000;
const CLOSE_NOT_LIVE = 4001;
const CLOSE_SUPERSEDED = 4002;

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

export async function serve(db: DatabaseSync, host: string, port: number): Promise<string> {
  const server = createServer((_request, response) => response.writeHead(404).end());
  const sockets = new Map<string, WebSocket>();

  const flush = (session: string, atConnect: boolean): void => {
    const socket = sockets.get(session);
    if (socket === undefined) return;
    for (const push of transaction(db, () => toPush(db, session, atConnect)))
      send(socket, { t: "entry", ...push });
  };

  const hello = (
    socket: WebSocket,
    message: Extract<ClientMessage, { t: "hello" }>,
  ): Session | undefined => {
    const session = sessionByToken(db, message.token);
    if (!session?.live) {
      socket.close(CLOSE_NOT_LIVE, "unknown token, or the attempt ended");
      return undefined;
    }
    sockets.get(session.id)?.close(CLOSE_SUPERSEDED, "a newer connection took over");
    sockets.set(session.id, socket);
    const lowWater = transaction(db, () => {
      setSessionState(db, session.id, "idle");
      return confirm(db, session.id, message.inFile);
    });
    send(socket, { t: "welcome", session: session.id, role: session.role, lowWater });
    flush(session.id, true);
    return session;
  };

  const call = (
    socket: WebSocket,
    session: Session,
    message: Extract<ClientMessage, { t: "call" }>,
  ): void => {
    try {
      if (!isOpName(message.op)) throw new Error(`unknown operation ${message.op}`);
      const op = message.op;
      const done = transaction(db, () => runOp(db, session, op, message.args));
      send(socket, { t: "result", id: message.id, ok: true, value: done.value });
      for (const recipient of done.notify) flush(recipient, false);
    } catch (error) {
      send(socket, { t: "result", id: message.id, ok: false, error: reason(error) });
    }
  };

  const attach = (socket: WebSocket): void => {
    let token: string | undefined;
    let session: Session | undefined;
    const live = (): Session => {
      const current = token === undefined ? undefined : sessionByToken(db, token);
      if (!current?.live) throw new Error("the session is not live");
      return current;
    };
    const handle = (message: ClientMessage): void => {
      if (message.t === "hello") {
        session = hello(socket, message);
        token = session === undefined ? undefined : message.token;
      } else if (message.t === "ack") acknowledge(db, live().id, message.entry);
      else if (message.t === "activity") setSessionState(db, live().id, message.state);
      else call(socket, live(), message);
    };
    socket.on("message", (data) => {
      try {
        handle(parseClientMessage(text(data)));
      } catch (error) {
        socket.close(
          session === undefined ? CLOSE_NOT_LIVE : CLOSE_BAD_MESSAGE,
          reason(error).slice(0, 120),
        );
      }
    });
    socket.on("close", (code) => {
      if (session === undefined || sockets.get(session.id) !== socket) return;
      sockets.delete(session.id);
      setSessionState(db, session.id, code === 1000 ? "exited" : "lost");
    });
  };

  new WebSocketServer({ server, path: "/session" }).on("connection", attach);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("the server has no address");
  return `ws://${host}:${String(address.port)}/session`;
}

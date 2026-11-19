import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { isLaneName, type LaneName } from "../shared/lane-name.js";
import type { Daemon } from "./daemon.js";
import { HttpError } from "./errors.js";
import type { Lane } from "./lane.js";
import { proxyAgentConnection } from "./proxy.js";
import { parseCommand, parseInput, StreamSession } from "./stream-session.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new HttpError(400, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

function laneFromPath(segment: string | undefined): LaneName | null {
  return isLaneName(segment) ? segment : null;
}

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) json(res, error.status, { error: error.message });
  else json(res, 500, { error: error instanceof Error ? error.message : String(error) });
}

export function createAgentServer(daemon: Daemon): Server {
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    void routeAgent(daemon, req, res).catch((error: unknown) => fail(res, error));
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const laneName = parts[0] === "cdp" ? laneFromPath(parts[1]) : null;
    if (!laneName) {
      socket.destroy();
      return;
    }
    const lane = daemon.lane(laneName);
    void lane
      .start()
      .then(() => lane.browserWsUrl())
      .then((upstream) => {
        wss.handleUpgrade(req, socket, head, (client) => proxyAgentConnection(client, lane, upstream));
      })
      .catch(() => socket.destroy());
  });
  return server;
}

async function routeAgent(daemon: Daemon, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";
  if (parts[0] === "cdp" && parts[2] === "json" && parts[3] === "version") {
    const name = laneFromPath(parts[1]);
    if (!name) return json(res, 404, { error: "unknown lane" });
    await daemon.lane(name).start();
    return json(res, 200, {
      Browser: "fleet-browser",
      "Protocol-Version": "1.3",
      webSocketDebuggerUrl: `ws://${req.headers.host}/cdp/${name}`,
    });
  }
  if (parts[0] !== "v1") return json(res, 404, { error: "not found" });
  if (parts[1] === "health") return json(res, 200, { ok: true });
  if (parts[1] !== "lanes") return json(res, 404, { error: "not found" });
  if (parts.length === 2)
    return json(res, 200, await Promise.all(daemon.all().map((lane) => lane.snapshot())));
  const name = laneFromPath(parts[2]);
  if (!name) return json(res, 400, { error: "invalid lane name" });
  const lane = daemon.lane(name);
  const action = parts[3];
  if (!action && method === "GET") return json(res, 200, await lane.snapshot());
  if (method === "POST" && (action === "start" || action === "stop" || action === "restart")) {
    await lane[action]();
    return json(res, 200, await lane.snapshot());
  }
  if (action === "handoff") return agentHandoff(daemon, lane, parts, method, req, res, url);
  if (method === "POST" && (action === "login" || action === "otp" || action === "mail")) {
    return agentCredentials(daemon, lane, action, (await readJson(req)) as Record<string, unknown>, res);
  }
  if (action === "broker-status" && method === "GET")
    return json(res, 200, await daemon.credentials.status(lane));
  return json(res, 404, { error: "not found" });
}

async function agentCredentials(
  daemon: Daemon,
  lane: Lane,
  action: "login" | "otp" | "mail",
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const item = typeof body.item === "string" ? body.item.trim() : "";
  if (!item || item.length > 120) throw new HttpError(400, "item is required");
  if (action === "login") return json(res, 200, await daemon.credentials.login(lane, item));
  if (action === "otp") return json(res, 200, await daemon.credentials.otp(lane, item, body.submit === true));
  const kind = body.kind === "code" ? "code" : body.kind === "link" ? "link" : null;
  if (!kind) throw new HttpError(400, "kind must be link or code");
  const seconds = (value: unknown, fallback: number, max: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(value, max)) : fallback;
  return json(
    res,
    200,
    await daemon.credentials.mail(lane, item, kind, {
      match: typeof body.match === "string" ? body.match : undefined,
      pattern: typeof body.pattern === "string" ? body.pattern : undefined,
      sinceSeconds: seconds(body.sinceSeconds, 600, 24 * 3600),
      waitSeconds: seconds(body.waitSeconds, 0, 280),
      submit: body.submit === true,
    }),
  );
}

async function agentHandoff(
  daemon: Daemon,
  lane: Lane,
  parts: string[],
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const id = parts[4];
  if (!id && method === "POST") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const reason =
      typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : null;
    if (!reason) return json(res, 400, { error: "reason is required" });
    const wait =
      typeof body.waitSeconds === "number" ? body.waitSeconds : daemon.config.handoff.defaultWaitSeconds;
    await lane.start();
    return json(res, 200, lane.openHandoff(reason, Math.max(10, Math.min(wait, 24 * 3600))));
  }
  if (!id && method === "GET") return json(res, 200, lane.handoff);
  if (id && parts[5] === "wait" && method === "GET") {
    const timeout = Math.min(Number(url.searchParams.get("timeout") ?? "30"), 55) * 1000;
    const handoff = await lane.waitHandoff(id, timeout);
    return json(res, handoff ? 200 : 404, handoff ?? { error: "unknown handoff" });
  }
  if (id && parts[5] === "cancel" && method === "POST") {
    const handoff = lane.resolveHandoff(id, "cancelled");
    return json(res, handoff ? 200 : 404, handoff ?? { error: "unknown handoff" });
  }
  return json(res, 404, { error: "not found" });
}

function boundedInt(raw: string | null, min: number, max: number, fallback: number): number {
  const value = raw === null ? fallback : Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function createStreamServer(daemon: Daemon): Server {
  return createServer((req, res) => {
    if (!daemon.tokens.matches(req.headers.authorization))
      return json(res, 401, { error: "missing or wrong bearer token" });
    void routeStream(daemon, req, res).catch((error: unknown) => fail(res, error));
  });
}

async function routeStream(daemon: Daemon, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";
  if (parts[0] !== "v1") return json(res, 404, { error: "not found" });
  if (parts[1] === "events" && method === "GET") return eventsStream(daemon, req, res);
  if (parts[1] !== "lanes") return json(res, 404, { error: "not found" });
  if (parts.length === 2)
    return json(res, 200, await Promise.all(daemon.all().map((lane) => lane.snapshot())));
  const name = laneFromPath(parts[2]);
  if (!name) return json(res, 400, { error: "invalid lane name" });
  const lane = daemon.lane(name);
  const action = parts[3];
  if (!action && method === "GET") return json(res, 200, await lane.snapshot());
  const viewerId = (url.searchParams.get("viewer") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  if (action && !viewerId) return json(res, 400, { error: "viewer query parameter is required" });
  if (action === "stream" && method === "GET") {
    lane.streams.get(viewerId)?.dispose();
    lane.viewerBack(viewerId);
    const session = new StreamSession(res, lane, viewerId, {
      maxWidth: boundedInt(url.searchParams.get("maxWidth"), 320, 1920, 1440),
      quality: boundedInt(url.searchParams.get("quality"), 30, 90, 70),
    });
    lane.streams.set(viewerId, session);
    await session.start().catch((error: unknown) => {
      session.dispose();
      if (!res.headersSent) fail(res, error);
    });
    return;
  }
  const session = lane.streams.get(viewerId) as StreamSession | undefined;
  if (action === "input" && method === "POST") {
    if (!session) throw new HttpError(409, "no open stream for this viewer");
    const body = (await readJson(req)) as { events?: unknown };
    if (!Array.isArray(body.events)) throw new HttpError(400, "events must be an array");
    const events = body.events.map(parseInput);
    if (events.some((event) => event === null)) throw new HttpError(400, "an input event is malformed");
    const applied = await session.input(events as NonNullable<(typeof events)[number]>[]);
    return json(res, 200, { applied });
  }
  if (action === "command" && method === "POST") {
    if (!session) throw new HttpError(409, "no open stream for this viewer");
    const command = parseCommand(await readJson(req));
    if (!command) throw new HttpError(400, "the command is malformed");
    await session.command(command);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "not found" });
}

function eventsStream(daemon: Daemon, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  for (const lane of daemon.all())
    void lane.snapshot().then((snapshot) => res.write(`event: lane\ndata: ${JSON.stringify(snapshot)}\n\n`));
  const onLane = (snapshot: unknown): void =>
    void res.write(`event: lane\ndata: ${JSON.stringify(snapshot)}\n\n`);
  const onHandoff = (payload: unknown): void =>
    void res.write(`event: handoff\ndata: ${JSON.stringify(payload)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  daemon.on("lane", onLane);
  daemon.on("handoff", onHandoff);
  req.on("close", () => {
    clearInterval(ping);
    daemon.off("lane", onLane);
    daemon.off("handoff", onHandoff);
  });
}

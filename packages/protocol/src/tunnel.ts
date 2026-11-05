import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { Cdp } from "./cdp.ts";

const TUNNEL_CONNECT_MS = 45_000;
const FAILURE_CHARS = 300;

const RELAY = [
  'const net = require("node:net");',
  "const upstream = net.connect(Number(process.argv[2]), process.argv[1]);",
  "process.stdin.pipe(upstream);",
  "upstream.pipe(process.stdout);",
  'upstream.on("error", (error) => { process.stderr.write(error.message); process.exitCode = 1; process.stdin.destroy(); });',
  'upstream.on("close", () => { process.stdin.destroy(); });',
].join("\n");

const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Tunnel {
  readonly port: number;
  failure(): string | undefined;
  forget(): void;
  close(): void;
}

interface Target {
  readonly host: string;
  readonly port: number;
}

function wire(socket: Socket, run: readonly string[], note: (failure: string) => void): void {
  const [file = "", ...args] = run;
  const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
  let said = "";
  child.stderr.on("data", (chunk: Buffer) => {
    said = `${said}${chunk.toString("utf8")}`.slice(-FAILURE_CHARS);
  });
  child.stdin.on("error", () => undefined);
  child.stdout.on("error", () => undefined);
  socket.on("error", () => undefined);
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  child.once("error", (error) => {
    note(`${file}: ${error.message}`);
    socket.destroy();
  });
  child.once("close", (code) => {
    if (code !== 0)
      note(said.trim() === "" ? `${file} exited with status ${String(code)}` : said.trim());
    socket.end();
  });
  socket.once("close", () => {
    child.kill();
  });
}

async function openTunnel(route: readonly string[], target: Target): Promise<Tunnel> {
  const command = ["node", "-e", RELAY, target.host, String(target.port)].map(quote).join(" ");
  const sockets = new Set<Socket>();
  const state: { failure: string | undefined } = { failure: undefined };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    wire(socket, [...route, command], (failure) => {
      state.failure = failure;
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the tunnel has no port");
  return {
    port: address.port,
    failure: () => state.failure,
    forget: () => {
      state.failure = undefined;
    },
    close: () => {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}

export interface Dial {
  readonly connect: () => Promise<Cdp>;
  readonly close: () => void;
}

export function dial(route: readonly string[], endpoint: string): Dial {
  const wanted = new URL(endpoint);
  if (wanted.protocol !== "http:" && wanted.protocol !== "ws:")
    throw new Error(`the browser address ${endpoint} must be an http or ws URL`);
  if (route.length === 0) return { connect: () => Cdp.connect(endpoint), close: () => undefined };
  const target = {
    host: wanted.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: Number(wanted.port) || 80,
  };
  let tunnel: Promise<Tunnel> | undefined;
  return {
    async connect() {
      tunnel ??= openTunnel(route, target);
      const open = await tunnel.catch((error: unknown) => {
        tunnel = undefined;
        throw error;
      });
      const near = new URL(endpoint);
      near.hostname = "127.0.0.1";
      near.port = String(open.port);
      open.forget();
      return Cdp.connect(near.toString(), TUNNEL_CONNECT_MS).catch((error: unknown) => {
        const failure = open.failure();
        throw new Error(failure === undefined ? reason(error) : `${reason(error)} (${failure})`, {
          cause: error,
        });
      });
    },
    close() {
      void tunnel?.then((open) => {
        open.close();
      });
    },
  };
}

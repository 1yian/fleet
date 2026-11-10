import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const READY_MS = 20_000;
const FAILURE_CHARS = 300;

export interface Socks {
  readonly port: number;
  readonly ended: Promise<string>;
  readonly close: () => void;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  if (address === null || typeof address === "string") throw new Error("no free port");
  return address.port;
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

const sshArguments = (host: string, port: number): string[] => [
  "-N",
  "-D",
  `127.0.0.1:${String(port)}`,
  "-o",
  "BatchMode=yes",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  host,
];

export async function openSocks(host: string, signal: AbortSignal): Promise<Socks> {
  const port = await freePort();
  const child = spawn("ssh", sshArguments(host, port), {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let said = "";
  child.stderr.on("data", (chunk: Buffer) => {
    said = `${said}${chunk.toString("utf8")}`.slice(-FAILURE_CHARS);
  });
  const ended = new Promise<string>((resolve) => {
    child.once("exit", (code) => {
      resolve(said.trim() === "" ? `ssh exited with status ${String(code)}` : said.trim());
    });
    child.once("error", (error) => {
      resolve(`ssh: ${error.message}`);
    });
  });
  const close = (): void => {
    child.kill("SIGTERM");
  };
  const deadline = Date.now() + READY_MS;
  try {
    while (!(await accepts(port))) {
      signal.throwIfAborted();
      const early = await Promise.race([ended, sleep(100, undefined)]);
      if (early !== undefined) throw new Error(`ssh -D to ${host} failed: ${early}`);
      if (Date.now() > deadline)
        throw new Error(
          `ssh -D to ${host} did not open its proxy within ${String(READY_MS / 1000)} s`,
        );
    }
  } catch (error) {
    close();
    throw error;
  }
  return { port, ended, close };
}

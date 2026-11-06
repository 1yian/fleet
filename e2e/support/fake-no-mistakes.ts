import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const EXECUTABLE = join(dirname(SELF), "no-mistakes");
const READY_MS = 15_000;

const [command = "", ...args] = process.argv.slice(2);

function rootOf(rest: readonly string[]): string {
  const root = rest[rest.indexOf("--root") + 1];
  if (root === undefined) throw new Error("--root needs a folder");
  return root;
}

function retitle(...words: string[]): void {
  process.title = [EXECUTABLE, ...words].join(" ");
}

function ask(root: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const socket = connect(join(root, "socket"));
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (reply += chunk));
    socket.once("error", () => {
      resolve(undefined);
    });
    socket.once("close", () => {
      const pid = Number(reply.trim().replace(/^daemon /, ""));
      resolve(Number.isInteger(pid) && pid > 0 ? pid : undefined);
    });
  });
}

function launch(...words: string[]): number {
  const child = spawn(process.execPath, [SELF, ...words], { detached: true, stdio: "ignore" });
  child.unref();
  return Number(child.pid);
}

async function ensureDaemon(root: string): Promise<void> {
  const running = await ask(root);
  if (running !== undefined) {
    process.stdout.write(`${JSON.stringify({ daemon: running, started: false })}\n`);
    return;
  }
  launch("daemon", "run", "--root", root);
  for (const deadline = Date.now() + READY_MS; Date.now() < deadline;) {
    const pid = await ask(root);
    if (pid !== undefined) {
      process.stdout.write(`${JSON.stringify({ daemon: pid, started: true })}\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no daemon answered on ${root}`);
}

async function published(): Promise<void> {
  const gate = process.env["FAKE_NM_PUBLISH_AFTER"];
  while (gate !== undefined && !existsSync(gate)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function serve(root: string): void {
  retitle("daemon", "run", "--root", root);
  mkdirSync(root, { recursive: true });
  const sink = launch("daemon", "log-sink", "--root", root);
  const step = spawn("sleep", ["1000000"], { stdio: "ignore" });
  const server = createServer((socket) => {
    socket.end(`daemon ${String(process.pid)}\n`);
  });
  server.listen(join(root, "socket"), () => {
    void published().then(() => {
      const record = { pid: process.pid, started_at: new Date().toISOString() };
      writeFileSync(
        join(root, "tree.json"),
        JSON.stringify({ daemon: process.pid, sink, step: step.pid }),
      );
      writeFileSync(join(root, "daemon.pid"), JSON.stringify(record));
    });
  });
  process.on("SIGTERM", () => {
    for (const pid of [sink, Number(step.pid)]) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        void 0;
      }
    }
    process.exit(0);
  });
}

function idle(): void {
  setInterval(() => undefined, 1 << 30);
}

if (command === "axi") {
  await ensureDaemon(process.env["FAKE_NM_ROOT"] ?? rootOf(args));
} else if (command === "daemon" && args[0] === "run") {
  serve(rootOf(args));
} else if (command === "daemon" && args[0] === "log-sink") {
  retitle("daemon", "log-sink", "--root", rootOf(args));
  idle();
} else if (command === "health") {
  process.stdout.write(`${String((await ask(args[0] ?? "")) ?? "none")}\n`);
} else if (command === "lookalike") {
  const [root = "", pidFile = ""] = args;
  const pid = launch("lookalike-run", root, pidFile);
  process.stdout.write(`${String(pid)}\n`);
} else if (command === "lookalike-run") {
  const [root = "", pidFile = ""] = args;
  retitle("daemon", "run", "--root", root);
  writeFileSync(pidFile, String(process.pid));
  idle();
} else {
  throw new Error(`unknown command ${command}`);
}

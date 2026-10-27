import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { herdr } from "./host.ts";
import { shimmedEnv } from "./shims.ts";
import { StringDecoder } from "node:string_decoder";

const TAIL_LINES = 40;
const MAX_LINE_CHARS = 2000;
const TIMEOUT_EXIT = 124;
const INTERRUPTED_EXIT = 130;
const KILL_GRACE_MS = 5000;
const DRAIN_MS = 1000;
const GROUP_POLL_MS = 50;
const MAX_RETRY_MS = 30_000;
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const EARLY_REPORT_MS = 300;

interface Job {
  readonly url: string;
  readonly token: string;
  readonly job: number;
  readonly command: string;
  readonly timeoutMs: number;
  readonly heartbeatMs: number;
  readonly keep: Keep;
}

interface Keep {
  readonly lines: number;
  readonly lineChars: number;
}

function readJob(file: string): Job {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  rmSync(file);
  if (typeof value !== "object" || value === null) throw new Error("the job file holds no object");
  const field = (key: string): unknown => Reflect.get(value, key);
  const [url, token, job, command, timeoutMs, heartbeatMs, tailLines, lineChars] = [
    "url",
    "token",
    "job",
    "command",
    "timeoutMs",
    "heartbeatMs",
    "tailLines",
    "lineChars",
  ].map(field);
  if (typeof url !== "string" || typeof token !== "string" || typeof command !== "string") {
    throw new Error("the job file lacks url, token, or command");
  }
  if (typeof job !== "number" || typeof timeoutMs !== "number" || typeof heartbeatMs !== "number")
    throw new Error("the job file lacks job, timeoutMs, or heartbeatMs");
  const keep = { lines: count(tailLines, TAIL_LINES), lineChars: count(lineChars, MAX_LINE_CHARS) };
  return {
    url,
    token,
    job,
    command,
    timeoutMs,
    heartbeatMs,
    keep,
  };
}

const count = (value: unknown, otherwise: number): number =>
  typeof value === "number" ? value : otherwise;

class Stream {
  private readonly decoder = new StringDecoder("utf8");
  private rest = "";
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  write(chunk: Buffer): string[] {
    const parts = (this.rest + this.decoder.write(chunk)).split(/\r\n|\r(?!$)|\n/);
    this.rest = (parts.pop() ?? "").slice(-this.max);
    return parts.map((line) => line.slice(-this.max));
  }

  end(): string {
    return (this.rest + this.decoder.end()).replace(/\r$/, "").slice(-this.max);
  }
}

class Tail {
  private lines: string[] = [];
  readonly out: Stream;
  readonly err: Stream;
  private readonly keep: number;

  constructor({ lines, lineChars }: Keep) {
    this.keep = lines;
    this.out = new Stream(lineChars);
    this.err = new Stream(lineChars);
  }

  add(lines: string[]): void {
    this.lines = this.lines.concat(lines).slice(-this.keep);
  }

  flush(): void {
    this.add([this.out.end(), this.err.end()].filter((line) => line !== ""));
  }

  text(): string {
    return this.lines.join("\n").trim();
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function mirror(out: NodeJS.WriteStream): (chunk: Buffer) => void {
  let open = true;
  out.on("error", () => {
    open = false;
  });
  return (chunk) => {
    if (open) out.write(chunk);
  };
}

async function run(job: Job): Promise<{ exitCode: number; outputTail: string }> {
  const tail = new Tail(job.keep);
  const child = spawn("sh", ["-c", job.command], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: shimmedEnv(process.env),
  });
  const pid = child.pid;
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    try {
      return pid !== undefined && process.kill(-pid, signal);
    } catch {
      return false;
    }
  };
  const mirrorOut = mirror(process.stdout);
  const mirrorErr = mirror(process.stderr);
  child.stdout.on("data", (chunk: Buffer) => {
    mirrorOut(chunk);
    tail.add(tail.out.write(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    mirrorErr(chunk);
    tail.add(tail.err.write(chunk));
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      resolve();
    }),
  );
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => {
      resolve(code);
    }),
  );
  let reason: "timeout" | "interrupted" | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const stop = (why: "timeout" | "interrupted"): void => {
    if (reason !== undefined) return;
    reason = why;
    signalGroup("SIGTERM");
    killTimer = setTimeout(() => {
      signalGroup("SIGKILL");
    }, KILL_GRACE_MS);
  };
  const onSignal = (): void => {
    stop("interrupted");
    void Promise.race([exited, sleep(EARLY_REPORT_MS)]).then(() => {
      tail.flush();
      const outputTail = `${tail.text()}\ninterrupted`.trim();
      void call(job, "job.finish", { job: job.job, exitCode: INTERRUPTED_EXIT, outputTail });
    });
  };
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  const timer = setTimeout(() => {
    stop("timeout");
  }, job.timeoutMs);
  const code = await exited;
  clearTimeout(timer);
  for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
  while (reason !== undefined && signalGroup(0)) await sleep(GROUP_POLL_MS);
  clearTimeout(killTimer);
  await Promise.race([closed, sleep(DRAIN_MS)]);
  child.stdout.destroy();
  child.stderr.destroy();
  tail.flush();
  if (reason === "interrupted") tail.add(["interrupted"]);
  const forced = reason === "timeout" ? TIMEOUT_EXIT : INTERRUPTED_EXIT;
  return { exitCode: reason === undefined ? (code ?? 1) : forced, outputTail: tail.text() };
}

function call(job: Job, op: string, args: object): Promise<Response | undefined> {
  const headers = { authorization: `Bearer ${job.token}`, "content-type": "application/json" };
  const body = JSON.stringify({ op, args });
  return fetch(job.url, { method: "POST", headers, body }).then(
    (response) => response,
    () => undefined,
  );
}

async function post(job: Job, result: { exitCode: number; outputTail: string }): Promise<void> {
  for (let wait = 1000; ; wait = Math.min(wait * 2, MAX_RETRY_MS)) {
    const response = await call(job, "job.finish", { job: job.job, ...result });
    if (response?.status === 200 || response?.status === 401) return;
    console.error(
      `cardd did not take the result (status ${String(response?.status ?? 0)}); retrying`,
    );
    await sleep(wait);
  }
}

const job = readJob(process.argv[2] ?? "");
const heartbeat = setInterval(() => {
  void call(job, "job.alive", { job: job.job });
}, job.heartbeatMs);
const result = await run(job);
console.log(`\n[run_long] job ${String(job.job)} exited ${String(result.exitCode)}`);
await post(job, result);
clearInterval(heartbeat);
const tab = process.env["HERDR_TAB_ID"];
if (tab !== undefined) await herdr("local", ["tab", "close", tab]).catch(() => 0);

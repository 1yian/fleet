// The run_long wrapper (spec section 11.1). It runs one command in the herdr tab
// where the captain can watch it, keeps the last lines of output, and posts the
// result to cardd once, retrying while cardd is down. It tells cardd that it is
// alive until the result is taken. It reads its job from a private file, so the
// token never appears in shell history.
// Usage: node job.ts <job file>
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const TAIL_LINES = 40;
const TIMEOUT_EXIT = 124;
const INTERRUPTED_EXIT = 130;
const KILL_GRACE_MS = 5000;
const DRAIN_MS = 1000;
const MAX_RETRY_MS = 30_000;
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

interface Job {
  readonly url: string;
  readonly token: string;
  readonly job: number;
  readonly command: string;
  readonly timeoutMs: number;
  readonly heartbeatMs: number;
}

function readJob(file: string): Job {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  rmSync(file);
  if (typeof value !== "object" || value === null) throw new Error("the job file holds no object");
  const field = (key: string): unknown => Reflect.get(value, key);
  const [url, token, job, command, timeoutMs, heartbeatMs] = [
    "url",
    "token",
    "job",
    "command",
    "timeoutMs",
    "heartbeatMs",
  ].map(field);
  if (typeof url !== "string" || typeof token !== "string" || typeof command !== "string") {
    throw new Error("the job file lacks url, token, or command");
  }
  if (typeof job !== "number" || typeof timeoutMs !== "number" || typeof heartbeatMs !== "number")
    throw new Error("the job file lacks job, timeoutMs, or heartbeatMs");
  return { url, token, job, command, timeoutMs, heartbeatMs };
}

class Stream {
  private readonly decoder = new StringDecoder("utf8");
  private rest = "";

  /** The complete lines in this chunk. The unfinished line waits for the next chunk. */
  write(chunk: Buffer): string[] {
    const parts = (this.rest + this.decoder.write(chunk)).split("\n");
    this.rest = parts.pop() ?? "";
    return parts;
  }

  end(): string {
    return this.rest + this.decoder.end();
  }
}

/** The last lines of the output. A line split across reads, or a character split across bytes, stays whole. */
class Tail {
  private lines: string[] = [];
  readonly out = new Stream();
  readonly err = new Stream();

  add(lines: string[]): void {
    this.lines = this.lines.concat(lines).slice(-TAIL_LINES);
  }

  text(): string {
    return this.lines
      .concat([this.out.end(), this.err.end()].filter((line) => line !== ""))
      .slice(-TAIL_LINES)
      .join("\n")
      .trim();
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function run(job: Job): Promise<{ exitCode: number; outputTail: string }> {
  const tail = new Tail();
  const child = spawn("sh", ["-c", job.command], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      if (pid !== undefined) process.kill(-pid, signal);
    } catch {
      // The group is already gone.
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    tail.add(tail.out.write(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
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
  const stop = (why: "timeout" | "interrupted"): void => {
    if (reason !== undefined) return;
    reason = why;
    signalGroup("SIGTERM");
    setTimeout(() => {
      signalGroup("SIGKILL");
    }, KILL_GRACE_MS).unref();
  };
  const onSignal = (): void => {
    stop("interrupted");
  };
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  const timer = setTimeout(() => {
    stop("timeout");
  }, job.timeoutMs);
  const code = await exited;
  clearTimeout(timer);
  for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
  await Promise.race([closed, sleep(DRAIN_MS)]);
  child.stdout.destroy();
  child.stderr.destroy();
  if (reason === "interrupted") tail.add(["interrupted"]);
  const forced = reason === "timeout" ? TIMEOUT_EXIT : INTERRUPTED_EXIT;
  return { exitCode: reason === undefined ? (code ?? 1) : forced, outputTail: tail.text() };
}

/** Calls an operation on cardd as the worker. Returns the HTTP status, or 0 if cardd did not answer. */
function call(job: Job, op: string, args: object): Promise<number> {
  const headers = { authorization: `Bearer ${job.token}`, "content-type": "application/json" };
  const body = JSON.stringify({ op, args });
  return fetch(job.url, { method: "POST", headers, body }).then(
    (response) => response.status,
    () => 0,
  );
}

/** Posts the result until cardd answers. A 401 means the attempt ended: nobody waits for it. */
async function post(job: Job, result: { exitCode: number; outputTail: string }): Promise<void> {
  for (let wait = 1000; ; wait = Math.min(wait * 2, MAX_RETRY_MS)) {
    const status = await call(job, "job.finish", { job: job.job, ...result });
    if (status === 200 || status === 401) return;
    console.error(`cardd did not take the result (status ${String(status)}); retrying`);
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

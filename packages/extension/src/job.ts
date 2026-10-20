// The run_long wrapper (spec section 11.1). It runs one command in the herdr tab
// where the captain can watch it, keeps the last lines of output, and posts the
// result to cardd once, retrying while cardd is down. It reads its job from a
// private file, so the token never appears in shell history.
// Usage: node job.ts <job file>
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const TAIL_LINES = 40;
const TIMEOUT_EXIT = 124;
const MAX_RETRY_MS = 30_000;

interface Job {
  readonly url: string;
  readonly token: string;
  readonly job: number;
  readonly command: string;
  readonly timeoutMs: number;
}

function readJob(file: string): Job {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  rmSync(file);
  if (typeof value !== "object" || value === null) throw new Error("the job file holds no object");
  const field = (key: string): unknown => Reflect.get(value, key);
  const [url, token, job, command, timeoutMs] = ["url", "token", "job", "command", "timeoutMs"].map(
    field,
  );
  if (typeof url !== "string" || typeof token !== "string" || typeof command !== "string") {
    throw new Error("the job file lacks url, token, or command");
  }
  if (typeof job !== "number" || typeof timeoutMs !== "number")
    throw new Error("the job file lacks job or timeoutMs");
  return { url, token, job, command, timeoutMs };
}

async function run(job: Job): Promise<{ exitCode: number; outputTail: string }> {
  let tail: string[] = [];
  const child = spawn("sh", ["-c", job.command], { stdio: ["inherit", "pipe", "pipe"] });
  const keep = (chunk: Buffer, out: NodeJS.WriteStream): void => {
    out.write(chunk);
    tail = [...tail, ...chunk.toString("utf8").split("\n")].slice(-TAIL_LINES - 1);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    keep(chunk, process.stdout);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    keep(chunk, process.stderr);
  });
  const deadline = { passed: false };
  const timer = setTimeout(() => {
    deadline.passed = true;
    child.kill("SIGTERM");
  }, job.timeoutMs);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  const exitCode = deadline.passed ? TIMEOUT_EXIT : (code ?? 1);
  return { exitCode, outputTail: tail.join("\n").trim() };
}

/** Posts the result until cardd answers. A 401 means the attempt ended: nobody waits for it. */
async function post(job: Job, result: { exitCode: number; outputTail: string }): Promise<void> {
  const body = JSON.stringify({ op: "job.finish", args: { job: job.job, ...result } });
  const headers = { authorization: `Bearer ${job.token}`, "content-type": "application/json" };
  for (let wait = 1000; ; wait = Math.min(wait * 2, MAX_RETRY_MS)) {
    const status = await fetch(job.url, { method: "POST", headers, body }).then(
      (response) => response.status,
      () => 0,
    );
    if (status === 200 || status === 401) return;
    console.error(`cardd did not take the result (status ${String(status)}); retrying`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

const job = readJob(process.argv[2] ?? "");
const result = await run(job);
console.log(`\n[run_long] job ${String(job.job)} exited ${String(result.exitCode)}`);
await post(job, result);

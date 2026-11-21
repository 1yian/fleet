import { readFileSync, rmSync } from "node:fs";
import { constants } from "node:os";
import { basename } from "node:path";
import { check, OPS, type OpArgs } from "@fleet/protocol";
import Type from "typebox";
import { spawnDetached } from "./detached.ts";
import { herdr } from "./host.ts";
import { jobHandshake } from "./job-http.ts";
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
const REGISTRATION_ATTEMPTS = 3;

interface Job {
  readonly url: string;
  readonly token: string;
  readonly job: number;
  readonly command: string;
  readonly launch?: string;
  readonly timeoutMs: number;
  readonly heartbeatMs: number;
  readonly keep: Keep;
}

interface Keep {
  readonly lines: number;
  readonly lineChars: number;
}

const JobFile = Type.Object({
  url: Type.String(),
  token: Type.String(),
  job: Type.Integer(),
  timeoutMs: Type.Number(),
  heartbeatMs: Type.Integer({ minimum: 1 }),
  tailLines: Type.Optional(Type.Number()),
  lineChars: Type.Optional(Type.Number()),
  command: Type.Optional(Type.String()),
  launch: Type.Optional(
    Type.Object({
      id: OPS["job.register"].args.properties.launch,
      command: OPS["job.prepare"].args.properties.command,
    }),
  ),
});

function readJob(file: string): Job {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  rmSync(file);
  const { url, token, job, timeoutMs, heartbeatMs, tailLines, lineChars, command, launch } = check(
    JobFile,
    raw,
  );
  const keep = { lines: tailLines ?? TAIL_LINES, lineChars: lineChars ?? MAX_LINE_CHARS };
  const common = { url, token, job, timeoutMs, heartbeatMs, keep };
  if (launch === undefined) {
    if (command === undefined) throw new Error("the legacy job file has no command");
    return { ...common, command };
  }
  if (basename(file) !== `fleet-job-${String(job)}-${launch.id}.json`)
    throw new Error("job file does not match its launch identity");
  return { ...common, command: launch.command, launch: launch.id };
}

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

type JobResult = Pick<OpArgs<"job.finish">, "exitCode" | "outputTail" | "commandNotStarted">;

async function run(job: Job): Promise<JobResult> {
  const tail = new Tail(job.keep);
  console.error(
    "[run_long] WARNING: Bash pipefail is enabled, not errexit. A command list returns its last command's status: 'false; true' succeeds. Use 'suite && formatter' or preserve $? explicitly. Intentional || and if recovery retain normal shell semantics; nested shells own their failure policy.",
  );
  const child = spawnDetached("bash", ["-o", "pipefail", "-c", job.command], {
    stdio: ["ignore", "pipe", "pipe"],
    env: shimmedEnv(process.env),
  });
  const pid = child.pid;
  const startup = pid === undefined ? { commandNotStarted: true as const } : {};
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
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128 + constants.signals[signal]));
    });
    child.once("error", (error) => {
      const message = `could not start command: ${error.message}`;
      console.error(message);
      tail.add([message]);
      resolve(127);
    });
  });
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
      void call(job, "job.finish", {
        job: job.job,
        exitCode: INTERRUPTED_EXIT,
        outputTail,
        ...startup,
      });
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
  return { exitCode: reason === undefined ? code : forced, outputTail: tail.text(), ...startup };
}

function call(job: Job, op: string, args: object): Promise<Response | undefined> {
  const headers = { authorization: `Bearer ${job.token}`, "content-type": "application/json" };
  const body = JSON.stringify({ op, args });
  return fetch(job.url, { method: "POST", headers, body, redirect: "error" }).then(
    (response) => response,
    () => undefined,
  );
}

async function post(job: Job, result: JobResult): Promise<void> {
  for (let wait = 1000; ; wait = Math.min(wait * 2, MAX_RETRY_MS)) {
    const response = await call(job, "job.finish", { job: job.job, ...result });
    if (response?.status === 200 || response?.status === 401) return;
    console.error(
      `cardd did not take the result (status ${String(response?.status ?? 0)}); retrying`,
    );
    await sleep(wait);
  }
}

async function register(job: Job, launch: string): Promise<boolean> {
  for (let attempt = 0; attempt < REGISTRATION_ATTEMPTS; attempt += 1) {
    const outcome = await jobHandshake(job, "job.register", {
      job: job.job,
      launch,
      pid: process.pid,
    })
      .then((reply) => reply.ok && check(OPS["job.register"].result, reply.value).registered)
      .catch(() => undefined);
    if (outcome !== undefined) return outcome;
    if (attempt + 1 < REGISTRATION_ATTEMPTS) await sleep(250);
  }
  return false;
}

const job = readJob(process.argv[2] ?? "");
let stopped = false;
const stopBeforeRun = (): void => {
  stopped = true;
};
for (const signal of STOP_SIGNALS) process.on(signal, stopBeforeRun);
const heartbeat = setInterval(() => {
  void call(job, "job.alive", { job: job.job });
}, job.heartbeatMs);
const confirmed = job.launch === undefined || (await register(job, job.launch));
for (const signal of STOP_SIGNALS) process.off(signal, stopBeforeRun);
const result: JobResult = stopped
  ? { exitCode: INTERRUPTED_EXIT, outputTail: "interrupted", commandNotStarted: true }
  : confirmed
    ? await run(job)
    : {
        exitCode: 127,
        outputTail: "could not start: cardd did not confirm wrapper registration",
        commandNotStarted: true,
      };
console.log(`\n[run_long] job ${String(job.job)} exited ${String(result.exitCode)}`);
await post(job, result);
clearInterval(heartbeat);
process.exitCode = result.exitCode;
const tab = process.env["HERDR_TAB_ID"];
if (tab !== undefined) await herdr("local", ["tab", "close", tab]).catch(() => 0);

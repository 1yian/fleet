import { spawn } from "node:child_process";

const MAX_DRIVES = 500;
const MAX_REATTACH_FAILURES = 3;

type Mode = "run" | "rerun" | "respond" | "answer";
type Posted = "running" | "gated" | "passed" | "cancelled" | "failed" | "unavailable";

interface Config {
  readonly url: string;
  readonly token: string;
  readonly validation: number;
  readonly mode: Mode;
  readonly first: readonly string[];
  readonly reattach: readonly string[];
  readonly probeDelaysMs: readonly number[];
}

interface Seen {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Reading {
  readonly run: string | undefined;
  readonly outcome: string | undefined;
  readonly gate: boolean;
  readonly error: string | undefined;
}

const DAEMON_DOWN =
  /start daemon|connect to daemon|subscribe .*reconnect|daemon (is )?(shutting down|crashed|not running)|connection refused|econnrefused|\.sock/i;
const WAIT_ELAPSED = /wait of \S+ elapsed/i;

const MODES: readonly unknown[] = ["run", "rerun", "respond", "answer"];
const isTexts = (value: unknown): boolean =>
  Array.isArray(value) && value.every((each) => typeof each === "string");
const isNumbers = (value: unknown): boolean =>
  Array.isArray(value) && value.every((each) => typeof each === "number");

function isConfig(value: unknown): value is Config {
  if (typeof value !== "object" || value === null) return false;
  const field = (key: string): unknown => Reflect.get(value, key);
  return [
    typeof field("url") === "string",
    typeof field("token") === "string",
    typeof field("validation") === "number",
    MODES.includes(field("mode")),
    isTexts(field("first")),
    isTexts(field("reattach")),
    isNumbers(field("probeDelaysMs")),
  ].every(Boolean);
}

function configOf(): Config {
  const value: unknown = JSON.parse(process.env["FLEET_VALIDATE"] ?? "null");
  delete process.env["FLEET_VALIDATE"];
  if (!isConfig(value)) throw new Error("FLEET_VALIDATE is not a validation job");
  return value;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function exec(args: readonly string[]): Promise<Seen> {
  return new Promise((resolve) => {
    const child = spawn("no-mistakes", [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function unquote(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2
    ? trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, " ")
    : trimmed;
}

function read(seen: Seen): Reading {
  const lines = seen.stdout.split("\n");
  const top = (key: string): string | undefined => {
    const line = lines.find((each) => each.startsWith(`${key}:`));
    return line === undefined ? undefined : unquote(line.slice(key.length + 1));
  };
  const run =
    /^\s+run_id:\s*(\S+)/m.exec(seen.stdout)?.[1] ??
    /^run:\s*\n\s+id:\s*(\S+)/m.exec(seen.stdout)?.[1] ??
    /Rerun started for \S+\s+(\S+)/.exec(seen.stdout)?.[1];
  const error = top("error") ?? (seen.code === 0 ? undefined : seen.stderr.trim().slice(-600));
  return {
    run: run === undefined ? undefined : unquote(run),
    outcome: top("outcome"),
    gate: lines.some((each) => each.startsWith("gate:")),
    error,
  };
}

async function post(config: Config, state: Posted, fields: object): Promise<void> {
  const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
  const body = JSON.stringify({
    op: "validation.result",
    args: { validation: config.validation, state, ...fields },
  });
  for (let wait = 500; ; wait = Math.min(wait * 2, 15_000)) {
    const response = await fetch(config.url, { method: "POST", headers, body }).catch(
      () => undefined,
    );
    if (response?.status === 200 || response?.status === 401 || response?.status === 400) return;
    await sleep(wait);
  }
}

async function daemonRunning(): Promise<boolean> {
  const seen = await exec(["axi"]);
  return /^daemon:\s*running/m.test(seen.stdout);
}

async function daemonBack(config: Config): Promise<boolean> {
  for (const delay of [0, ...config.probeDelaysMs]) {
    await sleep(delay);
    if (await daemonRunning()) return true;
  }
  return false;
}

function finished(reading: Reading): Posted | undefined {
  const { outcome } = reading;
  if (outcome === undefined) return reading.gate ? "gated" : undefined;
  if (outcome === "failed") return "failed";
  if (outcome === "cancelled") return "cancelled";
  return "passed";
}

const elapsed = (seen: Seen, error: string): boolean =>
  WAIT_ELAPSED.test(error) || WAIT_ELAPSED.test(seen.stdout);

class Drive {
  private run: string | undefined;
  private args: readonly string[];
  private failures = 0;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
    this.args = config.first;
  }

  private post(state: Posted, fields: object): Promise<void> {
    const run = this.run === undefined ? {} : { run: this.run };
    return post(this.config, state, { ...run, ...fields });
  }

  async go(): Promise<number> {
    if (this.config.mode === "rerun" && !(await daemonBack(this.config))) {
      await this.post("unavailable", {
        error: "the no-mistakes daemon is not running, so the rerun did not start",
      });
      console.log("validate: the no-mistakes daemon is down; nothing was rerun");
      return 1;
    }
    for (let drives = 0; drives < MAX_DRIVES; drives += 1) {
      const code = await this.step();
      if (code !== undefined) return code;
    }
    await this.post("failed", { error: "the run was still driving after the drive limit" });
    return 1;
  }

  private async step(): Promise<number | undefined> {
    const seen = await exec(this.args);
    process.stdout.write(seen.stdout);
    process.stderr.write(seen.stderr);
    const reading = read(seen);
    if (reading.run !== undefined && reading.run !== this.run) {
      this.run = reading.run;
      await this.post("running", {});
    }
    const done = finished(reading);
    if (done === undefined) return this.next(seen, reading.error ?? "");
    const outcome = reading.outcome === undefined ? {} : { outcome: reading.outcome };
    const error = done === "failed" ? { error: reading.error ?? "the run failed" } : {};
    await this.post(done, { ...outcome, ...error });
    return done === "failed" ? 1 : 0;
  }

  private async next(seen: Seen, error: string): Promise<number | undefined> {
    this.args = this.config.reattach;
    if (seen.code === 0) return undefined;
    if (elapsed(seen, error)) {
      this.failures = 0;
      return undefined;
    }
    if (DAEMON_DOWN.test(error) && !(await daemonBack(this.config))) {
      await this.post("unavailable", { error });
      return 1;
    }
    this.failures += 1;
    if (this.failures < MAX_REATTACH_FAILURES) return undefined;
    await this.post("failed", { error });
    return 1;
  }
}

process.exitCode = await new Drive(configOf()).go();

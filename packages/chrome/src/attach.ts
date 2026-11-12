import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { headersNameTheGuard, type Guarding } from "./marker.ts";

type Reach = Guarding | "unreachable";

interface Options {
  readonly target: string;
  readonly display: string;
  readonly guardPort: number;
  readonly xpra: string;
  readonly remoteXpra: string;
  readonly ssh: readonly string[];
  readonly retryMs: number;
}

interface Ended {
  readonly code: number | null;
  readonly byServer: boolean;
}

const USAGE =
  "usage: fleet-attach [user@]host [--display 99] [--guard-port 9222] [--xpra <xpra on this machine>] [--remote-xpra <xpra on the host>] [--ssh ssh] [--retry-ms 1000]";
const MAC_XPRA = "/Applications/Xpra.app/Contents/MacOS/Xpra";
const TARGET = /^([A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/;
const KEEPALIVE = ["-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3"];
const RETRY_EXIT_CODES = new Set([1, 2, 8, 9, 18, 20, 25, 26]);
const SERVER_ENDED = "server requested disconnect";
const STABLE_MS = 30_000;
const BACKOFF_STEPS = 10;
const EXIT_UNGUARDED = 99;
const EXIT_USAGE = 64;

function say(message: string): void {
  process.stderr.write(`fleet-attach: ${message}\n`);
}

const DEFAULT_XPRA = existsSync(MAC_XPRA) ? MAC_XPRA : "xpra";

const validPort = (port: number): boolean => Number.isInteger(port) && port > 0 && port < 65536;

function parse(): Options {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      display: { type: "string", default: "99" },
      "guard-port": { type: "string", default: "9222" },
      xpra: { type: "string", default: DEFAULT_XPRA },
      "remote-xpra": { type: "string", default: "xpra" },
      ssh: { type: "string", default: "ssh" },
      "retry-ms": { type: "string", default: "1000" },
    },
  });
  const [target, ...extra] = positionals;
  const display = values.display.replace(/^:/, "");
  const guardPort = Number(values["guard-port"]);
  const retryMs = Number(values["retry-ms"]);
  const valid =
    target !== undefined &&
    extra.length === 0 &&
    TARGET.test(target) &&
    /^\d{1,4}$/.test(display) &&
    validPort(guardPort) &&
    Number.isInteger(retryMs) &&
    retryMs > 0;
  if (!valid) throw new Error(USAGE);
  return {
    target,
    display,
    guardPort,
    xpra: values.xpra,
    remoteXpra: values["remote-xpra"],
    ssh: values.ssh.split(/\s+/).filter((word) => word !== ""),
    retryMs,
  };
}

function guardThere(options: Options): Promise<Reach> {
  const [command = "ssh", ...front] = options.ssh;
  return new Promise((resolve) => {
    const child = spawn(
      command,
      [
        ...front,
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        ...KEEPALIVE,
        options.target,
        "curl",
        "--silent",
        "--max-time",
        "5",
        "--output",
        "/dev/null",
        "--dump-header",
        "-",
        `http://127.0.0.1:${String(options.guardPort)}/json/version`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let headers = "";
    child.stdout.on("data", (chunk: Buffer) => {
      headers += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      say(`cannot run ${command}: ${error.message}`);
      resolve("unreachable");
    });
    child.once("close", (code) => {
      if (code === 0) resolve(headersNameTheGuard(headers) ? "guarded" : "unguarded");
      else resolve(code === 7 ? "down" : "unreachable");
    });
  });
}

function attachArguments(options: Options): string[] {
  return [
    "attach",
    `ssh://${options.target}/${options.display}`,
    `--remote-xpra=${options.remoteXpra}`,
    `--ssh=${[...options.ssh, ...KEEPALIVE].join(" ")}`,
    "--window-close=disconnect",
    "--reconnect=no",
    "--clipboard=yes",
    "--opengl=auto",
    "--notifications=no",
    "--splash=no",
    "--mdns=no",
  ];
}

function runXpra(options: Options, adopt: (child: ChildProcess) => void): Promise<Ended> {
  return new Promise((resolve) => {
    const child = spawn(options.xpra, attachArguments(options), {
      stdio: ["inherit", "pipe", "pipe"],
    });
    adopt(child);
    let byServer = false;
    const forward = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
      stream.write(chunk);
      if (chunk.toString("utf8").includes(SERVER_ENDED)) byServer = true;
    };
    child.stdout.on("data", forward(process.stdout));
    child.stderr.on("data", forward(process.stderr));
    child.once("error", (error) => {
      say(`cannot run ${options.xpra}: ${error.message}`);
      resolve({ code: 127, byServer: false });
    });
    child.once("close", (code) => {
      resolve({ code, byServer });
    });
  });
}

type Step = { readonly exit: number } | { readonly again: string; readonly stable: boolean };

const attachesAgain = (ended: Ended): boolean =>
  ended.code === null || ended.code === 0 || RETRY_EXIT_CODES.has(ended.code);

class Launcher {
  private readonly options: Options;
  private readonly stop = new AbortController();
  private current: ChildProcess | undefined;
  private failures = 0;

  constructor(options: Options) {
    this.options = options;
  }

  interrupt(): void {
    this.stop.abort();
    this.current?.kill("SIGTERM");
  }

  async run(): Promise<number> {
    while (!this.stop.signal.aborted) {
      const step = await this.once();
      if ("exit" in step) return step.exit;
      this.failures = step.stable ? 1 : this.failures + 1;
      say(step.again);
      await this.pause();
    }
    return 0;
  }

  private async pause(): Promise<void> {
    const steps = Math.min(2 ** Math.max(this.failures - 1, 0), BACKOFF_STEPS);
    await sleep(this.options.retryMs * steps, undefined, { signal: this.stop.signal }).catch(
      () => undefined,
    );
  }

  private async once(): Promise<Step> {
    const { options } = this;
    const reach = await guardThere(options);
    if (reach === "unguarded") {
      say(
        `something answers on ${options.target} port ${String(options.guardPort)} that is not the guard, so nothing is attached. Start the guard there first.`,
      );
      return { exit: EXIT_UNGUARDED };
    }
    if (reach !== "guarded") {
      const where = `${options.target} port ${String(options.guardPort)}`;
      const again =
        reach === "down"
          ? `the guard is not answering on ${where}, trying again`
          : `${options.target} is not reachable, trying again`;
      return { again, stable: false };
    }
    say(`attaching to ${options.target} display ${options.display}`);
    const started = Date.now();
    const ended = await runXpra(options, (child) => {
      this.current = child;
    });
    this.current = undefined;
    return this.after(ended, Date.now() - started >= STABLE_MS);
  }

  private after(ended: Ended, stable: boolean): Step {
    if (this.stop.signal.aborted || (ended.code === 0 && !ended.byServer)) return { exit: 0 };
    if (!attachesAgain(ended)) return { exit: ended.code ?? 1 };
    const again = ended.byServer
      ? "the host ended the session, attaching again"
      : "the link to the host dropped, attaching again";
    return { again, stable };
  }
}

function main(): Promise<number> {
  const launcher = new Launcher(parse());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      launcher.interrupt();
    });
  }
  return launcher.run();
}

main().then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    say(error instanceof Error ? error.message : String(error));
    process.exit(EXIT_USAGE);
  },
);

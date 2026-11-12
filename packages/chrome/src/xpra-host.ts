import { spawn, type ChildProcess } from "node:child_process";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { guardHere } from "./marker.ts";

const USAGE =
  "usage: fleet-chrome xpra [--display 99] [--guard-port 9222] [--xpra xpra] [--clipboard]";
const EXIT_UNGUARDED = 99;
const EXIT_NO_GUARD = 98;
const EXIT_USAGE = 64;
const MISSES_BEFORE_STOP = 2;

function say(message: string): void {
  process.stderr.write(`fleet-chrome xpra: ${message}\n`);
}

function serverArguments(display: string, clipboard: boolean): string[] {
  const runtime = process.env["XDG_RUNTIME_DIR"];
  if (runtime === undefined || runtime === "")
    throw new Error("XDG_RUNTIME_DIR is not set, so the Xpra socket has no place to live");
  const socket = `${runtime}/xpra/${hostname().split(".")[0] ?? "host"}-${display}`;
  return [
    "start",
    `:${display}`,
    "--use-display=yes",
    "--daemon=no",
    `--bind=${socket}`,
    "--socket-permissions=600",
    "--html=off",
    "--mdns=no",
    `--clipboard=${clipboard ? "yes" : "no"}`,
    "--notifications=no",
    "--printing=no",
    "--speaker=off",
    "--microphone=off",
    "--pulseaudio=no",
    "--dbus-launch=no",
    "--systemd-run=no",
    "--exit-with-children=no",
  ];
}

interface Options {
  readonly display: string;
  readonly port: number;
  readonly pollMs: number;
  readonly xpra: string;
  readonly clipboard: boolean;
}

function readOptions(): Options {
  const { values } = parseArgs({
    options: {
      display: { type: "string", default: "99" },
      "guard-port": { type: "string", default: "9222" },
      xpra: { type: "string", default: "xpra" },
      clipboard: { type: "boolean", default: false },
      "poll-ms": { type: "string", default: "2000" },
    },
  });
  const display = values.display.replace(/^:/, "");
  const port = Number(values["guard-port"]);
  const pollMs = Number(values["poll-ms"]);
  const valid =
    /^\d{1,4}$/.test(display) &&
    Number.isInteger(port) &&
    port > 0 &&
    port < 65536 &&
    Number.isInteger(pollMs) &&
    pollMs > 0;
  if (!valid) throw new Error(USAGE);
  return { display, port, pollMs, xpra: values.xpra, clipboard: values.clipboard };
}

async function refusal(port: number): Promise<number | undefined> {
  const before = await guardHere(port);
  if (before === "unguarded") {
    say(`something other than the guard answers on port ${String(port)}, so Xpra will not start`);
    return EXIT_UNGUARDED;
  }
  if (before === "down") {
    say(`the guard is not answering on port ${String(port)}, so Xpra will not start`);
    return EXIT_NO_GUARD;
  }
  return undefined;
}

function startXpra(options: Options): { child: ChildProcess; ended: Promise<number> } {
  const child = spawn(options.xpra, serverArguments(options.display, options.clipboard), {
    stdio: "inherit",
    env: { ...process.env, XPRA_BATCH_MAX_DELAY: "10" },
  });
  const ended = new Promise<number>((resolve) => {
    child.once("error", (error) => {
      say(`cannot run ${options.xpra}: ${error.message}`);
      resolve(127);
    });
    child.once("close", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 143));
    });
  });
  return { child, ended };
}

async function watchGuard(
  options: Options,
  child: ChildProcess,
  stop: AbortSignal,
): Promise<number | undefined> {
  let misses = 0;
  for (;;) {
    const waited = await sleep(options.pollMs, undefined, { signal: stop }).then(
      () => true,
      () => false,
    );
    if (!waited) return undefined;
    misses = (await guardHere(options.port)) === "guarded" ? 0 : misses + 1;
    if (misses >= MISSES_BEFORE_STOP) {
      say(`the guard stopped answering on port ${String(options.port)}, so Xpra is stopping`);
      child.kill("SIGTERM");
      return EXIT_NO_GUARD;
    }
  }
}

async function main(): Promise<number> {
  const options = readOptions();
  const refused = await refusal(options.port);
  if (refused !== undefined) return refused;
  const { child, ended } = startXpra(options);
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stop.abort();
      child.kill("SIGTERM");
    });
  }
  const watching = watchGuard(options, child, stop.signal);
  const code = await ended;
  stop.abort();
  return (await watching) ?? code;
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

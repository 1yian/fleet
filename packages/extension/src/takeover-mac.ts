import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Cdp } from "@fleet/protocol";

const READY_MS = 30_000;
const EXIT_MS = 10_000;
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface LocalChrome {
  readonly endpoint: string;
  readonly port: number;
  readonly exited: Promise<number | null>;
  readonly quit: () => Promise<void>;
}

export interface Launch {
  readonly profile: string;
  readonly socks: number;
}

const chromeBinary = (): string =>
  process.env["FLEET_CHROME_BIN"] ?? (process.platform === "darwin" ? MAC_CHROME : "google-chrome");

const extraArguments = (): string[] =>
  (process.env["FLEET_CHROME_ARGS"] ?? "").split(/\s+/).filter((each) => each !== "");

const portFile = (profile: string): string => join(profile, "DevToolsActivePort");

function portOf(profile: string): number | undefined {
  try {
    const port = Number(readFileSync(portFile(profile), "utf8").split("\n")[0]);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

async function alive(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${String(port)}/json/version`, {
    signal: AbortSignal.timeout(1_000),
  }).then(
    () => true,
    () => false,
  );
}

async function refuseRunning(profile: string): Promise<void> {
  const port = portOf(profile);
  if (port === undefined) return;
  if (await alive(port))
    throw new Error(
      `a Chrome already runs with this profile (debugging port ${String(port)}): finish its takeover first, or quit that Chrome`,
    );
  rmSync(portFile(profile), { force: true });
}

const chromeArguments = ({ profile, socks }: Launch): string[] => [
  `--user-data-dir=${profile}`,
  "--remote-debugging-port=0",
  `--proxy-server=socks5://127.0.0.1:${String(socks)}`,
  "--proxy-bypass-list=<-loopback>",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--no-first-run",
  "--no-default-browser-check",
  ...extraArguments(),
  "about:blank",
];

export async function launchChrome(launch: Launch, signal: AbortSignal): Promise<LocalChrome> {
  signal.throwIfAborted();
  mkdirSync(launch.profile, { recursive: true, mode: 0o700 });
  await refuseRunning(launch.profile);
  const child = spawn(chromeBinary(), chromeArguments(launch), { stdio: "ignore", detached: true });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", resolve);
    child.once("error", () => {
      resolve(null);
    });
  });
  const deadline = Date.now() + READY_MS;
  try {
    for (;;) {
      const port = portOf(launch.profile);
      const answering = port !== undefined && (await alive(port));
      signal.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Chrome exited at once (${chromeBinary()}): another Chrome may already hold this profile, or FLEET_CHROME_BIN is wrong`,
        );
      if (port !== undefined && answering) {
        const quit = async (): Promise<void> => {
          const cdp = await Cdp.connect(`http://127.0.0.1:${String(port)}`).catch(() => undefined);
          await cdp?.send("Browser.close").catch(() => undefined);
          cdp?.close();
          const stopped = await Promise.race([exited, sleep(EXIT_MS, "late")]);
          if (stopped === "late") child.kill("SIGKILL");
        };
        return { endpoint: `http://127.0.0.1:${String(port)}`, port, exited, quit };
      }
      if (Date.now() > deadline)
        throw new Error(
          `Chrome did not open its debugging port within ${String(READY_MS / 1000)} s`,
        );
      await sleep(100);
    }
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

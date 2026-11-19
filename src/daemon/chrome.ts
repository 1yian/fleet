import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";

const execFileAsync = promisify(execFile);

export interface ChromeLaunch {
  profileDir: string;
  port: number;
  screen: { width: number; height: number };
}

export function chromeArgs(launch: ChromeLaunch): string[] {
  return [
    `--user-data-dir=${launch.profileDir}`,
    `--remote-debugging-port=${launch.port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--password-store=basic",
    "--window-position=0,0",
    `--window-size=${launch.screen.width},${launch.screen.height}`,
    "--lang=en-US",
    "--restore-last-session",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
  ];
}

export async function assertPinnedChrome(config: Config): Promise<string> {
  const { stdout } = await execFileAsync(config.chrome.path, ["--version"]);
  const match = /(\d+\.\d+\.\d+\.\d+)/.exec(stdout);
  const actual = match?.[1];
  if (actual !== config.chrome.version) {
    throw new Error(
      `Chrome version ${actual ?? "unknown"} does not match the pinned ${config.chrome.version}; refusing to start`,
    );
  }
  return actual;
}

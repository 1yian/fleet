import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export function spawnDetached(
  command: string,
  args: readonly string[],
  options: { stdio: ["ignore", "pipe", "pipe"]; env?: NodeJS.ProcessEnv },
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnDetached(
  command: string,
  args: readonly string[],
  options: { stdio: "ignore"; env?: NodeJS.ProcessEnv },
): ChildProcess;
export function spawnDetached(
  command: string,
  args: readonly string[],
  options: { stdio: "ignore" | ["ignore", "pipe", "pipe"]; env?: NodeJS.ProcessEnv },
): ChildProcess {
  const launcher = (options.env ?? process.env)["FLEET_E2E_DETACH"];
  const spawnOptions = { ...options, detached: true as const };
  return launcher === undefined
    ? spawn(command, args, spawnOptions)
    : spawn(process.execPath, [launcher, command, ...args], spawnOptions);
}

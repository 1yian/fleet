import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import "./hermetic-env.ts";
import { registerGroup } from "./marked.ts";

const REAPER = fileURLToPath(new URL("./reaper.ts", import.meta.url));
let reaper: ChildProcess | undefined;

function tell(message: string): void {
  if (reaper === undefined) {
    reaper = spawn("node", [REAPER], { detached: true, stdio: ["pipe", "ignore", "inherit"] });
    registerGroup(reaper.pid);
    reaper.unref();
    reaper.stdin?.on("error", () => undefined);
    if (reaper.stdin instanceof Socket) reaper.stdin.unref();
  }
  reaper.stdin?.write(`${message}\n`);
}

export function guardCleanup(name: string, argv: readonly string[]): () => void {
  tell(`hook ${name} ${JSON.stringify(argv)}`);
  return () => {
    tell(`unhook ${name}`);
  };
}

export function spawnGuarded(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const child = spawn(command, args, { ...options, detached: true });
  const pid = child.pid;
  if (pid !== undefined) {
    const identity = registerGroup(pid, options.env ?? process.env);
    if (identity !== undefined) tell(`watch ${String(pid)} ${identity}`);
    child.once("exit", () => {
      tell(`release ${String(pid)}`);
    });
  }
  return child;
}

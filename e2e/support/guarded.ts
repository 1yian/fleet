import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import "./hermetic-env.ts";

const REAPER = fileURLToPath(new URL("./reaper.ts", import.meta.url));
let reaper: ChildProcess | undefined;

function tell(message: string): void {
  if (reaper === undefined) {
    reaper = spawn("node", [REAPER], { detached: true, stdio: ["pipe", "ignore", "inherit"] });
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

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return;
  }
}

export function spawnGuarded(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const child = spawn(command, args, { ...options, detached: true });
  const pid = child.pid;
  if (pid !== undefined) {
    tell(`watch ${String(pid)}`);
    child.once("exit", () => {
      killGroup(pid);
      tell(`release ${String(pid)}`);
    });
  }
  return child;
}

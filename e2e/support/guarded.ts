import type { ChildProcess, SpawnOptions } from "node:child_process";
import "./hermetic-env.ts";
import { groupIdentity, spawnOwned } from "./marked.ts";
import { tell } from "./reaper-client.ts";

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
  const child = spawnOwned(command, args, options);
  const pid = child.pid;
  if (pid !== undefined) {
    const identity = groupIdentity(pid);
    if (identity !== undefined) tell(`watch ${String(pid)} ${identity}`);
    child.once("exit", () => {
      tell(`release ${String(pid)}`);
    });
  }
  return child;
}

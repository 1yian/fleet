import { quote } from "@fleet/protocol/route";
import { herdr, shellIdle } from "./host.ts";
import { readLaneConfig } from "./lane-config.ts";
import { withLifecycleLock } from "./lifecycle-lock.ts";
import { withCompileCache } from "./scratch.ts";

const WAIT_MS = 60_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(done: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`the restart gave up waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function runRelaunch(
  pid: number,
  pane: string,
  home: string,
  args: readonly string[],
): Promise<void> {
  const relaunch = async (): Promise<void> => {
    await until(() => !alive(pid), `Pi (pid ${String(pid)}) to exit`);
    await until(() => shellIdle("local", pane), `the shell in pane ${pane}`);
    const direnv = process.env["FLEET_RELAUNCH_DIRENV"] ?? "";
    const resume = args.includes("--session-id") ? [] : ["--continue"];
    const pi = ["pi", ...resume, ...args];
    const command = withCompileCache(direnv === "" ? pi : ["direnv", "exec", direnv, ...pi])
      .map(quote)
      .join(" ");
    await herdr("local", ["pane", "run", pane, `cd ${quote(home)} && ${command}`]);
  };
  const lane = readLaneConfig(home)?.lane;
  if (lane === undefined) await relaunch();
  else await withLifecycleLock(home, lane, relaunch);
}

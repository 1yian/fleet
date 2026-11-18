import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const GROUPS_ENV = "FLEET_E2E_GROUPS";
export const LAB_GROUPS_ENV = "FLEET_E2E_LAB_GROUPS";

export interface Swept {
  readonly named: readonly string[];
  readonly survivors: number;
}

const validPid = (pid: number): boolean =>
  Number.isSafeInteger(pid) && pid > 1 && pid <= 2_147_483_647;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (!validPid(pid)) return;
  try {
    process.kill(-pid, signal);
  } catch {
    return;
  }
}

export function groupIdentity(pid: number): string | undefined {
  if (!validPid(pid)) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
      const [state, , group, ...rest] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return Number(group) === pid && state !== "Z" ? rest[16] : undefined;
    }
    const row = execFileSync("ps", ["-p", String(pid), "-o", "pgid=,stat=,lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const [group, state = "", ...started] = row.split(/\s+/);
    if (Number(group) === pid && state !== "" && !state.startsWith("Z") && started.length > 0)
      return started.join(" ");
  } catch {
    return undefined;
  }
  return undefined;
}

export function groupScopes(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[GROUPS_ENV] ?? "").split("\n").filter(isAbsolute);
}

export function registerGroup(
  pid: number | undefined,
  env = process.env,
  started = pid === undefined ? undefined : groupIdentity(pid),
): string | undefined {
  if (pid === undefined || !validPid(pid)) return undefined;
  const lab = env[LAB_GROUPS_ENV];
  const scopes = new Set([...groupScopes(env), ...(lab !== undefined && isAbsolute(lab) ? [lab] : [])]);
  for (const scope of scopes) {
    writeFileSync(join(scope, String(pid)), started ?? "", { mode: 0o600 });
  }
  return started;
}

export function signalOwnedGroup(pid: number | undefined, started: string | undefined, signal: NodeJS.Signals): void {
  if (pid !== undefined && started !== undefined && groupIdentity(pid) === started)
    killGroup(pid, signal);
}

function liveGroups(): Set<number> {
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pgid=,stat="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(rows.split("\n").flatMap((row) => {
      const [group, state] = row.trim().split(/\s+/);
      return state !== undefined && !state.startsWith("Z") ? [Number(group)] : [];
    }));
  } catch {
    throw new Error("could not verify end-to-end process groups");
  }
}

function outstanding(scope: string): { pid: number; started: string }[] {
  const entries = readdirSync(scope);
  if (entries.length === 0) return [];
  const live = liveGroups();
  return entries.flatMap((name) => {
    const pid = Number(name);
    if (!validPid(pid) || !live.has(pid)) return [];
    return [{ pid, started: readFileSync(join(scope, name), "utf8") }];
  });
}

export async function sweepGroups(scope: string, graceMs: number): Promise<Swept> {
  const deadline = Date.now() + graceMs;
  let left = outstanding(scope);
  while (left.length > 0 && Date.now() < deadline) {
    await delay(100);
    left = outstanding(scope);
  }
  const named = left.map(({ pid }) => `${String(pid)} process group`);
  if (left.length > 0) {
    for (const { pid, started } of left) signalOwnedGroup(pid, started, "SIGKILL");
    const deadline = Date.now() + 1_000;
    do {
      await delay(50);
      left = outstanding(scope);
    } while (left.length > 0 && Date.now() < deadline);
  }
  return { named, survivors: left.length };
}

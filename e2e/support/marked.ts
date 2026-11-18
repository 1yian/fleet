import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { verifyPrivateDirectory } from "./run-folders.ts";

export const GROUPS_ENV = "FLEET_E2E_GROUPS";
export const LAB_GROUPS_ENV = "FLEET_E2E_LAB_GROUPS";
const OWNED_LAUNCH = fileURLToPath(new URL("./owned-launch.ts", import.meta.url));

export interface Swept {
  readonly named: readonly string[];
  readonly unresolved: readonly number[];
}

const validPid = (pid: number): boolean =>
  Number.isSafeInteger(pid) && pid > 1 && pid <= 2_147_483_647;

function killGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (!validPid(pid)) return false;
  try {
    return process.kill(-pid, signal);
  } catch {
    return false;
  }
}

export function spawnOwned(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(process.execPath, [OWNED_LAUNCH, command, ...args], { ...options, detached: true });
}

function linuxIdentity(pid: number): string | undefined {
  const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  const [state, , group, ...rest] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(group) === pid && state !== "Z" ? rest[16] : undefined;
}

export function groupIdentity(pid: number): string | undefined {
  if (!validPid(pid)) return undefined;
  try {
    if (process.platform === "linux") return linuxIdentity(pid);
    const row = execFileSync("ps", ["-p", String(pid), "-o", "pgid=,stat=,lstart="], {
      timeout: 1_000,
      killSignal: "SIGKILL",
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
  const scopes: unknown = JSON.parse(env[GROUPS_ENV] ?? "[]");
  if (
    !Array.isArray(scopes) ||
    !scopes.every((scope): scope is string => typeof scope === "string" && isAbsolute(scope))
  )
    throw new Error("invalid end-to-end group registry list");
  return scopes;
}

export function openGroupScope(scope: string): string {
  mkdirSync(join(scope, "open"), { mode: 0o700 });
  return scope;
}

function registry(scope: string, state: "open" | "closed"): string {
  if (!isAbsolute(scope)) throw new Error("end-to-end group registry must be absolute");
  const path = join(scope, state);
  verifyPrivateDirectory(path);
  return path;
}

export function registerGroup(
  pid: number | undefined,
  env = process.env,
  started = pid === undefined ? undefined : groupIdentity(pid),
): string | undefined {
  if (pid === undefined || !validPid(pid)) return undefined;
  const lab = env[LAB_GROUPS_ENV];
  const scopes = new Set([...groupScopes(env), ...(lab === undefined ? [] : [lab])]);
  for (const scope of scopes) {
    const dir = registry(scope, "open");
    const pending = join(dir, `.pending-${randomUUID()}`);
    writeFileSync(pending, started ?? "", { flag: "wx", mode: 0o600 });
    renameSync(pending, join(dir, String(pid)));
  }
  return started;
}

export function signalOwnedGroup(
  pid: number | undefined,
  started: string | undefined,
  signal: NodeJS.Signals,
): boolean {
  return (
    pid !== undefined &&
    started !== undefined &&
    started !== "" &&
    groupIdentity(pid) === started &&
    killGroup(pid, signal)
  );
}

function liveGroups(): Set<number> {
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pgid=,stat="], {
      timeout: 1_000,
      killSignal: "SIGKILL",
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      rows.split("\n").flatMap((row) => {
        const [group, state] = row.trim().split(/\s+/);
        return state !== undefined && !state.startsWith("Z") ? [Number(group)] : [];
      }),
    );
  } catch {
    throw new Error("could not verify end-to-end process groups");
  }
}

function outstanding(scope: string): { pid: number; started: string }[] {
  const entries = readdirSync(scope, { withFileTypes: true });
  if (entries.length === 0) return [];
  const live = liveGroups();
  return entries.flatMap((entry) => {
    const pid = Number(entry.name);
    if (!validPid(pid) || pid === process.pid || !live.has(pid)) return [];
    return [{ pid, started: entry.isFile() ? readFileSync(join(scope, entry.name), "utf8") : "" }];
  });
}

function closeScope(scope: string): void {
  const closed = join(scope, "closed");
  if (existsSync(closed)) return;
  registry(scope, "open");
  try {
    renameSync(join(scope, "open"), closed);
  } catch (error) {
    if (!existsSync(closed)) throw error;
  }
}

export async function sweepGroups(scope: string, graceMs: number): Promise<Swept> {
  closeScope(scope);
  const dir = registry(scope, "closed");
  const deadline = Date.now() + graceMs;
  let left = outstanding(dir);
  while (left.length > 0 && Date.now() < deadline) {
    await delay(100);
    left = outstanding(dir);
  }
  const removed = new Set<number>();
  if (left.length > 0) {
    for (const { pid, started } of left) {
      if (signalOwnedGroup(pid, started, "SIGKILL")) removed.add(pid);
    }
    const settle = Date.now() + 1_000;
    do {
      await delay(50);
      left = outstanding(dir);
    } while (left.length > 0 && Date.now() < settle);
  }
  const unresolved = left.map(({ pid }) => pid);
  const named = [...removed]
    .filter((pid) => !unresolved.includes(pid))
    .map((pid) => `${String(pid)} process group`);
  return { named, unresolved };
}

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

interface Marked {
  readonly pid: number;
  readonly identity: string;
}

export interface Swept {
  readonly named: readonly string[];
  readonly survivors: number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const envMarker = (name: string, value: string, indexed = false): RegExp =>
  new RegExp(
    `^${name}=${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${indexed ? "\\.\\d+" : ""}$`,
  );

export function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    return;
  }
}

function linuxIdentity(pid: number, marker: RegExp): string | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const env = readFileSync(`/proc/${String(pid)}/environ`, "utf8");
    if (env.split("\0").some((entry) => marker.test(entry))) return started;
  } catch {
    return undefined;
  }
  return undefined;
}

function macSnapshot(environment: boolean): Map<number, string> {
  const table = execFileSync(
    "ps",
    [
      environment ? "-Exww" : "-xww",
      "-U",
      String(process.getuid?.()),
      "-o",
      "pid=,lstart=,command=",
    ],
    { encoding: "utf8", maxBuffer: 1 << 26 },
  );
  const rows = new Map<number, string>();
  for (const line of table.split("\n")) {
    const found = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (found?.[2] !== undefined) rows.set(Number(found[1]), found[2]);
  }
  return rows;
}

function markedProcesses(marker: RegExp): Marked[] {
  if (process.platform === "linux") {
    return readdirSync("/proc").flatMap((entry) => {
      const pid = Number(entry);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return [];
      const identity = linuxIdentity(pid, marker);
      return identity === undefined ? [] : [{ pid, identity }];
    });
  }
  const argv = macSnapshot(false);
  const full = macSnapshot(true);
  const current = macSnapshot(false);
  return [...argv].flatMap(([pid, identity]) => {
    const withEnv = full.get(pid);
    const owns =
      pid !== process.pid &&
      current.get(pid) === identity &&
      withEnv?.startsWith(`${identity} `) === true &&
      withEnv.slice(identity.length + 1).split(" ").some((entry) => marker.test(entry));
    return owns ? [{ pid, identity }] : [];
  });
}

function describe({ pid }: Marked): string {
  try {
    const name =
      process.platform === "linux"
        ? basename(readlinkSync(`/proc/${String(pid)}/exe`))
        : execFileSync("ps", ["-o", "ucomm=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return `${String(pid)} ${name}`;
  } catch {
    return String(pid);
  }
}

function killMarked(left: readonly Marked[], marker: RegExp): void {
  const mac =
    process.platform === "linux"
      ? undefined
      : new Map(markedProcesses(marker).map(({ pid, identity }) => [pid, identity]));
  for (const { pid, identity } of left) {
    const current = mac === undefined ? linuxIdentity(pid, marker) : mac.get(pid);
    if (current !== identity) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  }
}

export async function sweepMarked(marker: RegExp, graceMs: number): Promise<Swept> {
  const deadline = Date.now() + graceMs;
  let left = markedProcesses(marker);
  while (left.length > 0 && Date.now() < deadline) {
    await wait(200);
    left = markedProcesses(marker);
  }
  const named = left.map(describe);
  for (let round = 0; left.length > 0 && round < 10; round += 1) {
    killMarked(left, marker);
    await wait(100);
    left = markedProcesses(marker);
  }
  return { named, survivors: left.length };
}

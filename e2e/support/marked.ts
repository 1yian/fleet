import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

interface Marked {
  readonly pid: number;
  readonly command: string;
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

function hasMarker(pid: number, marker: RegExp): boolean {
  try {
    return readFileSync(`/proc/${String(pid)}/environ`, "utf8")
      .split("\0")
      .some((entry) => marker.test(entry));
  } catch {
    return false;
  }
}

function markedProcesses(marker: RegExp): Marked[] {
  if (process.platform === "linux") {
    return readdirSync("/proc").flatMap((entry) => {
      const pid = Number(entry);
      return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && hasMarker(pid, marker)
        ? [{ pid, command: "" }]
        : [];
    });
  }
  const table = execFileSync("ps", ["axeww", "-o", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  return table.split("\n").flatMap((line) => {
    const found = /^\s*(\d+)\s+(.*)$/.exec(line);
    const pid = Number(found?.[1]);
    const command = found?.[2] ?? "";
    return pid > 0 && pid !== process.pid && command.split(" ").some((entry) => marker.test(entry))
      ? [{ pid, command: "" }]
      : [];
  });
}

function describe({ pid, command }: Marked): string {
  try {
    const argv = readFileSync(`/proc/${String(pid)}/cmdline`, "utf8")
      .split("\0")
      .join(" ");
    return `${String(pid)} ${argv.trim().slice(0, 300)}`;
  } catch {
    return `${String(pid)} ${command.slice(0, 160)}`;
  }
}

function killMarked(left: readonly Marked[], marker: RegExp): void {
  for (const { pid } of left) {
    if (process.platform === "linux" && !hasMarker(pid, marker)) continue;
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

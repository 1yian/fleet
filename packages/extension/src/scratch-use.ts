import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, statfsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { records } from "./host.ts";
import { hostDir } from "./scratch.ts";

export type Metric = "inodes" | "space";

export interface FilesystemUse {
  readonly path: string;
  readonly inodesUsed: number;
  readonly inodesTotal: number;
  readonly bytesUsed: number;
  readonly bytesTotal: number;
}

export interface Largest {
  readonly name: string;
  readonly inodes: number;
  readonly bytes: number;
}

export interface Breakdown {
  readonly filesystem: string;
  readonly partial: boolean;
  readonly largest: readonly Largest[];
}

const WATCHED_TOP = 5;
const WALK_BUDGET_MS = 20_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberOf = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export const percentUsed = (use: FilesystemUse, metric: Metric): number | undefined => {
  const [used, total] =
    metric === "inodes" ? [use.inodesUsed, use.inodesTotal] : [use.bytesUsed, use.bytesTotal];
  return total > 0 ? (used / total) * 100 : undefined;
};

function useOf(path: string): FilesystemUse {
  const fs = statfsSync(path);
  const used = (fs.blocks - fs.bfree) * fs.bsize;
  return {
    path,
    inodesUsed: fs.files - fs.ffree,
    inodesTotal: fs.files,
    bytesUsed: used,
    bytesTotal: used + fs.bavail * fs.bsize,
  };
}

export function watchedFilesystems(): FilesystemUse[] {
  const seen = new Set<number>();
  const found: FilesystemUse[] = [];
  for (const path of ["/tmp", tmpdir(), hostDir()]) {
    try {
      const device = statSync(path).dev;
      if (seen.has(device)) continue;
      seen.add(device);
      found.push(useOf(path));
    } catch {
      continue;
    }
  }
  return found;
}

export interface Report {
  readonly host: string | undefined;
  readonly filesystems: readonly FilesystemUse[];
}

export function parseReport(value: unknown): Report {
  if (!isRecord(value)) throw new Error("the host's scratch report is not an object");
  const filesystems: FilesystemUse[] = [];
  for (const row of records(value["filesystems"])) {
    const path = row["path"];
    const inodesUsed = numberOf(row, "inodesUsed");
    const inodesTotal = numberOf(row, "inodesTotal");
    const bytesUsed = numberOf(row, "bytesUsed");
    const bytesTotal = numberOf(row, "bytesTotal");
    if (
      typeof path === "string" &&
      inodesUsed !== undefined &&
      inodesTotal !== undefined &&
      bytesUsed !== undefined &&
      bytesTotal !== undefined
    )
      filesystems.push({ path, inodesUsed, inodesTotal, bytesUsed, bytesTotal });
  }
  const host = value["host"];
  return { host: typeof host === "string" && host !== "" ? host : undefined, filesystems };
}

const sizeOf = (entry: Largest, metric: Metric): number =>
  metric === "inodes" ? entry.inodes : entry.bytes;

function measure(path: string, device: number, deadline: number): Largest {
  let inodes = 0;
  let bytes = 0;
  const pending = [path];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    let stat;
    try {
      stat = lstatSync(next);
    } catch {
      continue;
    }
    if (stat.dev !== device) continue;
    inodes += 1;
    bytes += stat.blocks * 512;
    if (!stat.isDirectory() || Date.now() > deadline) continue;
    try {
      for (const name of readdirSync(next)) pending.push(join(next, name));
    } catch {
      continue;
    }
  }
  return { name: path, inodes, bytes };
}

function filesystemOf(path: string): string {
  try {
    const line = execFileSync("df", ["-P", path], { encoding: "utf8" }).trim().split("\n").at(-1);
    return line?.split(/\s+/)[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function breakdown(path: string, metric: Metric, now: number): Breakdown {
  const deadline = now + WALK_BUDGET_MS;
  const device = statSync(path).dev;
  const sizes = readdirSync(path).map((name) => measure(join(path, name), device, deadline));
  const largest = sizes.sort((a, b) => sizeOf(b, metric) - sizeOf(a, metric)).slice(0, WATCHED_TOP);
  return { filesystem: filesystemOf(path), partial: Date.now() > deadline, largest };
}

export function parseBreakdown(value: unknown): Breakdown {
  if (!isRecord(value)) throw new Error("the host's directory report is not an object");
  const largest: Largest[] = [];
  for (const row of records(value["largest"])) {
    const name = row["name"];
    const inodes = numberOf(row, "inodes");
    const bytes = numberOf(row, "bytes");
    if (typeof name === "string" && inodes !== undefined && bytes !== undefined)
      largest.push({ name, inodes, bytes });
  }
  const filesystem = value["filesystem"];
  return {
    filesystem: typeof filesystem === "string" ? filesystem : "unknown",
    partial: value["partial"] === true,
    largest,
  };
}

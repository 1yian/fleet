import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, statfsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { records } from "./host.ts";
import { hostDir } from "./scratch.ts";

export type Metric = "inodes" | "space";

export interface FilesystemUse {
  readonly path: string;
  readonly roots: readonly string[];
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

type Roots = [string, ...string[]];

function useOf(roots: Roots): FilesystemUse {
  const [path] = roots;
  const fs = statfsSync(path);
  const used = (fs.blocks - fs.bfree) * fs.bsize;
  return {
    path,
    roots,
    inodesUsed: fs.files - fs.ffree,
    inodesTotal: fs.files,
    bytesUsed: used,
    bytesTotal: used + fs.bavail * fs.bsize,
  };
}

export function watchedFilesystems(): FilesystemUse[] {
  const byDevice = new Map<number, Roots>();
  for (const path of ["/tmp", tmpdir(), hostDir()]) {
    try {
      const device = statSync(path).dev;
      const roots = byDevice.get(device);
      if (roots === undefined) byDevice.set(device, [path]);
      else if (!roots.includes(path)) roots.push(path);
    } catch {
      continue;
    }
  }
  return Array.from(byDevice.values(), useOf);
}

export interface Report {
  readonly host: string | undefined;
  readonly filesystems: readonly FilesystemUse[];
}

function rootsOf(row: Record<string, unknown>, path: string): string[] {
  const listed = row["roots"];
  const roots = Array.isArray(listed)
    ? listed.filter((root): root is string => typeof root === "string")
    : [];
  return roots.length === 0 ? [path] : roots;
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
      filesystems.push({
        path,
        roots: rootsOf(row, path),
        inodesUsed,
        inodesTotal,
        bytesUsed,
        bytesTotal,
      });
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

export function breakdown(paths: readonly string[], metric: Metric, now: number): Breakdown {
  const deadline = now + WALK_BUDGET_MS;
  const sizes = paths.flatMap((path) => {
    const device = statSync(path).dev;
    return readdirSync(path).map((name) => measure(join(path, name), device, deadline));
  });
  const largest = sizes.sort((a, b) => sizeOf(b, metric) - sizeOf(a, metric)).slice(0, WATCHED_TOP);
  return { filesystem: filesystemOf(paths[0] ?? ""), partial: Date.now() > deadline, largest };
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

import { execFileSync } from "node:child_process";
import { ownHostName } from "./host.ts";
import { OPEN_SCRATCH_SCRIPT, tidy } from "./scratch.ts";
import { breakdown, percentUsed, watchedFilesystems, type Metric } from "./scratch-use.ts";

export interface ScratchOptions {
  readonly tidy: boolean;
  readonly open: string | undefined;
  readonly largest: readonly string[];
  readonly by: string | undefined;
  readonly json: boolean;
}

const gigabytes = (bytes: number): string => `${(bytes / 2 ** 30).toFixed(1)} GB`;

const metricOf = (by: string | undefined): Metric => {
  if (by === undefined || by === "inodes") return "inodes";
  if (by === "space") return "space";
  throw new Error(`--by takes inodes or space, not ${by}`);
};

function describeUse(): string[] {
  return watchedFilesystems().map((use) => {
    const inodes = percentUsed(use, "inodes");
    const space = percentUsed(use, "space");
    const share = (value: number | undefined): string =>
      value === undefined ? "n/a" : `${String(Math.round(value))}%`;
    return `${use.path}: ${share(inodes)} of inodes (${String(use.inodesUsed)} of ${String(use.inodesTotal)}), ${share(space)} of space (${gigabytes(use.bytesUsed)} of ${gigabytes(use.bytesTotal)})`;
  });
}

function openLines(card: string): string[] {
  const out = execFileSync("sh", ["-c", OPEN_SCRATCH_SCRIPT, "scratch", card], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return out.trim().split("\n");
}

export function scratchLines(options: ScratchOptions, now: number): string[] {
  if (options.open !== undefined) return openLines(options.open);
  if (options.largest.length > 0) {
    const found = breakdown(options.largest, metricOf(options.by), now);
    if (options.json) return [JSON.stringify(found)];
    return found.largest.map(
      (each) => `${each.name}: ${String(each.inodes)} inodes, ${gigabytes(each.bytes)}`,
    );
  }
  const tidied = options.tidy ? tidy(now) : undefined;
  if (options.json)
    return [JSON.stringify({ host: ownHostName(), tidied, filesystems: watchedFilesystems() })];
  const removed =
    tidied === undefined
      ? []
      : [
          `tidied: ${String(tidied.cacheFiles)} old compile cache files, ${
            tidied.cards.length === 0
              ? "no closed card folders"
              : `closed card folders ${tidied.cards.join(", ")}`
          }`,
        ];
  return [...removed, ...describeUse()];
}

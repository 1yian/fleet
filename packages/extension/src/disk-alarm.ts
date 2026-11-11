import { HostUnreachable } from "./host.ts";
import { isRecord } from "./lane-config.ts";
import {
  parseBreakdown,
  parseReport,
  percentUsed,
  type Breakdown,
  type FilesystemUse,
  type Largest,
  type Metric,
  type Report,
} from "./scratch-use.ts";

const ALARM_PERCENT = 75;

const TIDY_EVERY_MS = 60 * 60_000;
const DIRECTORY_CHECKS = 3;
export const DISK_MESSAGE = "fleet-disk";
export const DISK_CLEARED = "fleet-disk-cleared";
const METRICS: readonly Metric[] = ["inodes", "space"];

type Ask = (host: string, args: readonly string[]) => Promise<string>;

export interface Alert {
  readonly text: string;
  readonly urgent: boolean;
  readonly crossing?: string;
}

interface Crossing {
  readonly key: string;
  readonly use: FilesystemUse;
  readonly metric: Metric;
  readonly percent: number;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const lastJson = (out: string): unknown => JSON.parse(out.trim().split("\n").at(-1) ?? "null");

const count = (value: number): string => Math.round(value).toLocaleString("en-US");

const gigabytes = (bytes: number): string => `${(bytes / 2 ** 30).toFixed(1)} GB`;

const amount = (value: number, metric: Metric): string =>
  metric === "inodes" ? `${count(value)} inodes` : gigabytes(value);

function recordedCrossing(entry: unknown): { key: string; said: boolean } | undefined {
  if (!isRecord(entry)) return undefined;
  const said = entry["type"] === "custom_message" && entry["customType"] === DISK_MESSAGE;
  const cleared = entry["type"] === "custom" && entry["customType"] === DISK_CLEARED;
  if (!said && !cleared) return undefined;
  const body = entry[said ? "details" : "data"];
  const key = isRecord(body) ? body["crossing"] : undefined;
  return typeof key === "string" ? { key, said } : undefined;
}

function heldIn(entries: readonly unknown[]): Set<string> {
  const held = new Set<string>();
  for (const crossing of entries.map(recordedCrossing)) {
    if (crossing?.said === true) held.add(crossing.key);
    else if (crossing !== undefined) held.delete(crossing.key);
  }
  return held;
}

function crossingsIn(
  host: string,
  uses: readonly FilesystemUse[],
  held: ReadonlySet<string>,
  unlisted: Map<string, number>,
): { fresh: Crossing[]; released: string[] } {
  const fresh: Crossing[] = [];
  const released: string[] = [];
  const pairs = uses.flatMap((use) => METRICS.map((metric) => ({ use, metric })));
  for (const { use, metric } of pairs) {
    const percent = percentUsed(use, metric);
    if (percent === undefined) continue;
    const key = [host, use.path, metric].join("|");
    if (percent < ALARM_PERCENT) {
      if (held.has(key)) released.push(key);
      unlisted.delete(key);
    } else if (!held.has(key)) fresh.push({ key, use, metric, percent });
  }
  return { fresh, released };
}

function sizesOf({ use, metric }: Crossing): string {
  if (metric === "inodes") return `${count(use.inodesUsed)} of ${count(use.inodesTotal)}`;
  return `${gigabytes(use.bytesUsed)} of ${gigabytes(use.bytesTotal)}`;
}

function largestOf({ use, metric }: Crossing, found: Breakdown | undefined): string {
  if (found === undefined) return "The largest directories could not be read.";
  const sized = (each: Largest): string =>
    `${each.name} ${amount(metric === "inodes" ? each.inodes : each.bytes, metric)}`;
  const partial = found.partial ? " (counted for 20 seconds only)" : "";
  return `Largest under ${use.roots.join(", ")} by ${metric}${partial}: ${found.largest.map(sized).join("; ")}.`;
}

function described(host: string, crossing: Crossing, found?: Breakdown): string {
  const { use, metric, percent } = crossing;
  const name = found === undefined ? use.path : `${use.path} (${found.filesystem})`;
  const what = metric === "inodes" ? "its inodes" : "its space";
  const alarm = `${String(ALARM_PERCENT)}%`;
  const once = `This is said once. It is said again only after ${use.path} drops below ${alarm} and crosses it again.`;
  const level = `${String(Math.round(percent))}% of ${what} (${sizesOf(crossing)}), over the ${alarm} alarm.`;
  return `${host}: ${name} is at ${level} ${largestOf(crossing, found)} ${once}`;
}

async function breakdownOf(
  ask: Ask,
  host: string,
  { use, metric }: Crossing,
): Promise<Breakdown | undefined> {
  try {
    return parseBreakdown(
      lastJson(
        await ask(host, [
          "scratch",
          ...use.roots.flatMap((root) => ["--largest", root]),
          "--by",
          metric,
          "--json",
        ]),
      ),
    );
  } catch {
    return undefined;
  }
}

export interface DiskWatch {
  readonly ask: Ask;
  readonly send: (alert: Alert) => boolean;
  readonly clear: (crossing: string) => void;
  readonly idle: () => boolean;
  readonly entries: () => readonly unknown[];
  readonly now?: () => number;
}

export function diskWatch({
  ask,
  send,
  clear,
  idle,
  entries,
  now = Date.now,
}: DiskWatch): (host: string) => Promise<void> {
  const unlisted = new Map<string, number>();
  const tidied = new Map<string, number>();
  const unreadable = new Set<string>();

  const read = async (host: string): Promise<Report> => {
    const due = now() - (tidied.get(host) ?? Number.NEGATIVE_INFINITY) >= TIDY_EVERY_MS;
    const out = await ask(host, ["scratch", ...(due ? ["--tidy"] : []), "--json"]);
    const report = parseReport(lastJson(out));
    if (due) tidied.set(host, now());
    return report;
  };

  const announce = async (host: string, label: string, uses: readonly FilesystemUse[]) => {
    const { fresh, released } = crossingsIn(host, uses, heldIn(entries()), unlisted);
    for (const key of released) clear(key);
    for (const crossing of fresh) {
      if (!idle()) return;
      const found = await breakdownOf(ask, host, crossing);
      if (found === undefined) {
        const failed = (unlisted.get(crossing.key) ?? 0) + 1;
        unlisted.set(crossing.key, failed);
        if (failed < DIRECTORY_CHECKS) continue;
      }
      if (!idle()) return;
      const alert = {
        text: described(label, crossing, found),
        urgent: true,
        crossing: crossing.key,
      };
      if (!send(alert)) return;
      unlisted.delete(crossing.key);
      return;
    }
  };

  return async (host) => {
    try {
      const { host: named, filesystems } = await read(host);
      const label = host === "local" ? (named ?? host) : host;
      await announce(host, label, filesystems);
      if (unreadable.delete(host))
        send({ text: `the disk use of ${label} can be read again`, urgent: false });
    } catch (error) {
      if (error instanceof HostUnreachable) throw error;
      if (unreadable.has(host)) return;
      unreadable.add(host);
      const text = `the disk use of ${host} could not be read: ${messageOf(error)}`;
      send({ text, urgent: false });
    }
  };
}

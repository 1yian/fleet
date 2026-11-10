import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostUnreachable } from "./host.ts";
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
const ALARMS_FILE = join("state", "disk-alarms.json");
const METRICS: readonly Metric[] = ["inodes", "space"];

export type Ask = (host: string, args: readonly string[]) => Promise<string>;

export interface Alert {
  readonly text: string;
  readonly urgent: boolean;
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

function readHeld(home: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, ALARMS_FILE), "utf8"));
    return new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

function saveHeld(home: string, held: ReadonlySet<string>): void {
  try {
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, ALARMS_FILE), JSON.stringify([...held].sort()));
  } catch {
    return;
  }
}

function crossingsIn(
  host: string,
  uses: readonly FilesystemUse[],
  held: Set<string>,
): { fresh: Crossing[]; cleared: boolean } {
  const fresh: Crossing[] = [];
  let cleared = false;
  for (const use of uses) {
    for (const metric of METRICS) {
      const percent = percentUsed(use, metric);
      if (percent === undefined) continue;
      const key = [host, use.path, metric].join("|");
      if (percent < ALARM_PERCENT) cleared = held.delete(key) || cleared;
      else if (!held.has(key)) fresh.push({ key, use, metric, percent });
    }
  }
  return { fresh, cleared };
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
  return `Largest under ${use.path} by ${metric}${partial}: ${found.largest.map(sized).join("; ")}.`;
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
      lastJson(await ask(host, ["scratch", "--largest", use.path, "--by", metric, "--json"])),
    );
  } catch {
    return undefined;
  }
}

export function diskWatch(
  home: string,
  ask: Ask,
  send: (alert: Alert) => boolean,
  now: () => number = Date.now,
): (host: string) => Promise<void> {
  const held = readHeld(home);
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
    const { fresh, cleared } = crossingsIn(host, uses, held);
    if (cleared) saveHeld(home, held);
    for (const crossing of fresh) {
      const found = await breakdownOf(ask, host, crossing);
      if (!send({ text: described(label, crossing, found), urgent: true })) return;
      held.add(crossing.key);
      saveHeld(home, held);
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

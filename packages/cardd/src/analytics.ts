import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import type { Analytics } from "@fleet/protocol";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Tokens = Analytics["lanes"][number]["tokens"];
const empty = (): Tokens => ({ input: 0, cached: 0, output: 0 });
const bucket = (at: number, size: number): number => Math.floor(at / size) * size;

function add(into: Tokens, tokens: Readonly<Tokens>): void {
  into.input += tokens.input;
  into.cached += tokens.cached;
  into.output += tokens.output;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return record(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const count = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function usageOf(entry: Record<string, unknown> | undefined): Tokens | undefined {
  const usage = entry?.["usage"];
  if (!record(usage)) return undefined;
  const { input, cacheRead, cacheWrite, output } = usage;
  if (!count(input) || !count(cacheRead) || !count(cacheWrite) || !count(output)) return undefined;
  return { input: input + cacheWrite, cached: cacheRead, output };
}

async function ledgerAt(home: string): Promise<string | undefined> {
  try {
    const settings = resolve(home, "config/optchat.json");
    if (!(await stat(settings)).isFile()) return undefined;
    const config = parse(await readFile(settings, "utf8"));
    const memoryHome = config?.["memoryHome"];
    const profile = config?.["profile"];
    if (
      typeof memoryHome !== "string" ||
      memoryHome === "" ||
      typeof profile !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)
    )
      return undefined;
    const file = await realpath(resolve(home, memoryHome, "profiles", profile, "usage.jsonl"));
    return (await stat(file)).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

async function usageIn(file: string, from: number, to: number): Promise<Map<number, Tokens>> {
  const hours = new Map<number, Tokens>();
  const seen = new Set<string>();
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const entry = parse(line);
      const date = entry?.["date"];
      const at = typeof date === "string" ? Date.parse(date) : NaN;
      if (!(at >= from && at <= to)) continue;
      const tokens = usageOf(entry);
      if (tokens === undefined) continue;
      const id = entry?.["id"];
      if (typeof id === "string" && id !== "") {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const hour = bucket(at, HOUR);
      const total = hours.get(hour) ?? empty();
      add(total, tokens);
      hours.set(hour, total);
    }
    return hours;
  } catch {
    return new Map();
  } finally {
    lines.close();
    input.destroy();
  }
}

function closureCounts(db: DatabaseSync, to: number): Analytics["closures"] {
  const first = bucket(to, DAY) - 6 * DAY;
  const rows = db
    .prepare(`
    SELECT created_at - (created_at % ?) AS at, COUNT(DISTINCT card) AS count
    FROM entries
    WHERE kind = 'cleanup' AND json_extract(fields, '$.outcome') = 'done'
      AND created_at >= ? AND created_at <= ?
    GROUP BY at
  `)
    .all(DAY, first, to);
  const counts = new Map(rows.map((row) => [Number(row["at"]), Number(row["count"])]));
  return Array.from({ length: 7 }, (_, i) => {
    const at = first + i * DAY;
    return { at, count: counts.get(at) ?? 0 };
  });
}

async function ledgers(db: DatabaseSync): Promise<Map<string, string[]>> {
  const files = new Map<string, string[]>();
  for (const { name, home } of db.prepare("SELECT name, home FROM lanes ORDER BY name").all()) {
    if (typeof name !== "string" || typeof home !== "string") continue;
    const file = await ledgerAt(home);
    if (file !== undefined) files.set(file, [...(files.get(file) ?? []), name]);
  }
  return files;
}

export async function analytics(db: DatabaseSync, to: number): Promise<Analytics> {
  const from = to - DAY;
  const closures = closureCounts(db, to);
  const hourly = new Map<number, Tokens>();
  const lanes: Analytics["lanes"] = [];
  for (const [file, names] of await ledgers(db)) {
    const hours = await usageIn(file, from, to);
    if (hours.size === 0) continue;
    const tokens = empty();
    for (const [at, usage] of hours) {
      const hour = hourly.get(at) ?? empty();
      add(hour, usage);
      hourly.set(at, hour);
      add(tokens, usage);
    }
    lanes.push({ lane: names.join(" / "), tokens });
  }
  const hours: Analytics["hours"] = [];
  for (let at = bucket(from, HOUR); at <= to; at += HOUR)
    hours.push({ at, tokens: hourly.get(at) ?? null });
  return { from, to, hours, lanes, closures };
}

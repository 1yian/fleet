import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { laneHomes } from "./homes.ts";
import { isRecord, readLaneConfig } from "./lane-config.ts";
import { profileOf, settingsOf } from "./prerequisites.ts";

export const DAY_MS = 24 * 60 * 60_000;
const COLD_MIN_TOKENS = 1000;
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_RATE = 1.25;

export interface CostRow {
  readonly lane: string;
  readonly dollars: number;
  readonly inputPercent?: number;
  readonly coldStarts: number;
}

interface Turn {
  readonly model: string;
  readonly main: boolean;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly inputCost: number;
  readonly cacheReadCost: number;
  readonly cacheWriteCost: number;
  readonly total: number;
}

const num = (value: unknown): number => (typeof value === "number" ? value : 0);

function turnOf(line: string, since: number): Turn | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(entry) || typeof entry["date"] !== "string") return undefined;
  const { usage } = entry;
  if (!isRecord(usage) || !isRecord(usage["cost"]) || Date.parse(entry["date"]) < since)
    return undefined;
  const cost = usage["cost"];
  const priced = typeof entry["provider"] === "string";
  return {
    model: `${String(entry["provider"])}/${String(entry["model"])}`,
    main: priced && entry["role"] === "main",
    input: num(usage["input"]),
    cacheRead: num(usage["cacheRead"]),
    cacheWrite: num(usage["cacheWrite"]),
    inputCost: num(cost["input"]),
    cacheReadCost: num(cost["cacheRead"]),
    cacheWriteCost: num(cost["cacheWrite"]),
    total: num(cost["total"]),
  };
}

const median = (values: number[]): number => values.sort((a, b) => a - b)[values.length >> 1] ?? 0;

function fullPrices(turns: readonly Turn[]): Map<string, number> {
  const rates = new Map<string, number[]>();
  const add = (model: string, rate: number): void => {
    rates.set(model, [...(rates.get(model) ?? []), rate]);
  };
  for (const t of turns) {
    if (t.input >= 1 && t.inputCost > 0) add(t.model, t.inputCost / t.input);
  }
  const prices = new Map([...rates].map(([model, list]) => [model, median(list)]));
  for (const t of turns) {
    if (prices.has(t.model)) continue;
    if (t.cacheWrite > COLD_MIN_TOKENS)
      prices.set(t.model, t.cacheWriteCost / t.cacheWrite / CACHE_WRITE_RATE);
    else if (t.cacheRead > COLD_MIN_TOKENS)
      prices.set(t.model, t.cacheReadCost / t.cacheRead / CACHE_READ_RATE);
  }
  return prices;
}

function costRow(lane: string, ledger: string, now: number): CostRow {
  const turns = readFileSync(ledger, "utf8")
    .split("\n")
    .flatMap((line) => turnOf(line, now - DAY_MS) ?? []);
  const prices = fullPrices(turns);
  let full = 0;
  let paid = 0;
  for (const t of turns) {
    const price = prices.get(t.model);
    if (price === undefined) continue;
    full += (t.input + t.cacheRead + t.cacheWrite) * price;
    paid += t.inputCost + t.cacheReadCost + t.cacheWriteCost;
  }
  return {
    lane,
    dollars: turns.reduce((sum, t) => sum + t.total, 0),
    ...(full > 0 ? { inputPercent: (100 * paid) / full } : {}),
    coldStarts: turns.filter(
      (t) => t.main && t.cacheRead === 0 && t.input + t.cacheWrite >= COLD_MIN_TOKENS,
    ).length,
  };
}

export function costRows(root: string, now: number): CostRow[] {
  const own = readLaneConfig(root);
  const homes = [
    ...(own === undefined ? [] : [{ lane: own.lane, home: root }]),
    ...laneHomes(root),
  ];
  return homes.flatMap(({ lane, home }) => {
    const settings = settingsOf(home);
    if (settings === undefined) return [];
    const ledger = join(profileOf(home, settings), "usage.jsonl");
    return existsSync(ledger) ? [costRow(lane, ledger, now)] : [];
  });
}

export function costLine(row: CostRow): string {
  const percent = row.inputPercent === undefined ? "n/a" : `${row.inputPercent.toFixed(1)}%`;
  return `${row.lane}: $${row.dollars.toFixed(2)} in 24h, input at ${percent} of full price, cold starts: ${String(row.coldStarts)}`;
}

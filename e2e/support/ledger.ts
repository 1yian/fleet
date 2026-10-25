import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Turn {
  readonly hoursAgo: number;
  readonly role?: "main" | "compactor";
  readonly input: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly output?: number;
}

const PER_MILLION = { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 };
const dollars = (tokens: number, rate: number): number => (tokens * rate) / 1e6;

export function writeLedger(home: string, turns: readonly Turn[]): void {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(
    join(home, "config", "optchat.json"),
    JSON.stringify({ enabled: false, memoryHome: "data/optchat", profile: "main" }),
  );
  const profile = join(home, "data", "optchat", "profiles", "main");
  mkdirSync(profile, { recursive: true });
  const now = Date.now();
  const lines = turns.map((turn, index) => {
    const { input, cacheRead = 0, cacheWrite = 0, output = 0 } = turn;
    const cost = {
      input: dollars(input, PER_MILLION.input),
      output: dollars(output, PER_MILLION.output),
      cacheRead: dollars(cacheRead, PER_MILLION.cacheRead),
      cacheWrite: dollars(cacheWrite, PER_MILLION.cacheWrite),
    };
    return JSON.stringify({
      id: `turn-${String(index)}`,
      date: new Date(now - turn.hoursAgo * 3_600_000).toISOString(),
      role: turn.role ?? "main",
      provider: "anthropic",
      model: "opus",
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
      },
    });
  });
  appendFileSync(join(profile, "usage.jsonl"), `${lines.join("\n")}\n`);
}

export const OPS_TURNS: readonly Turn[] = [
  { hoursAgo: 30, input: 2000, cacheWrite: 98000 },
  { hoursAgo: 3, input: 2000, cacheWrite: 98000, output: 2000 },
  { hoursAgo: 2, input: 1000, cacheRead: 99000, output: 1000 },
  { hoursAgo: 1, role: "compactor", input: 5000, output: 1000 },
];
export const QUIET_TURNS: readonly Turn[] = [{ hoursAgo: 1, input: 1000, cacheRead: 99000 }];

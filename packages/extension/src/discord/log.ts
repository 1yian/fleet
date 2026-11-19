import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LINE_MAX = 200;
const REPEAT_MS = 600_000;

export type Log = (message: string) => void;

export const describeError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, LINE_MAX);

export function fileLog(file: string): Log {
  const lastWritten = new Map<string, number>();
  return (message) => {
    const now = Date.now();
    if (now - (lastWritten.get(message) ?? -REPEAT_MS) < REPEAT_MS) return;
    lastWritten.set(message, now);
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(file, `${new Date(now).toISOString()} ${message}\n`, { mode: 0o600 });
    } catch {
      return;
    }
  };
}

import { readFileSync } from "node:fs";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { methodOf } from "./patch.ts";
import { routerResumeAt } from "./router-cooldown.ts";

const FIRST_DELAY_MS = 30_000;
const LONGEST_DELAY_MS = 30 * 60_000;
const KEY = Symbol.for("fleet:patch:compaction-backoff");

interface Backoff {
  installed: boolean;
  failures: number;
  retryAt: number;
}

function isBackoff(value: unknown): value is Backoff {
  return (
    typeof value === "object" &&
    value !== null &&
    "installed" in value &&
    typeof value.installed === "boolean" &&
    "failures" in value &&
    typeof value.failures === "number" &&
    "retryAt" in value &&
    typeof value.retryAt === "number"
  );
}

function backoff(): Backoff {
  const found: unknown = Reflect.get(globalThis, KEY);
  if (isBackoff(found)) return found;
  const created = { installed: false, failures: 0, retryAt: 0 };
  Reflect.set(globalThis, KEY, created);
  return created;
}

function now(): number {
  const file = process.env["FLEET_CLOCK_FILE"];
  if (file === undefined) return Date.now();
  const at = Date.parse(readFileSync(file, "utf8"));
  return Number.isFinite(at) ? at : Date.now();
}

export function compactionFailed(error: string): void {
  const cell = backoff();
  const at = now();
  cell.failures += 1;
  const delay = Math.min(FIRST_DELAY_MS * 2 ** (cell.failures - 1), LONGEST_DELAY_MS);
  cell.retryAt = routerResumeAt(error, at) ?? at + delay;
}

export function compactionSucceeded(): void {
  const cell = backoff();
  cell.failures = 0;
  cell.retryAt = 0;
}

export function applyCompactionBackoff(): void {
  const cell = backoff();
  if (cell.installed) return;
  cell.installed = true;
  try {
    const run = methodOf(AgentSession.prototype, "_runAutoCompaction");
    Reflect.set(
      AgentSession.prototype,
      "_runAutoCompaction",
      function (this: object, ...args: unknown[]) {
        return now() < backoff().retryAt ? Promise.resolve(false) : run(this, ...args);
      },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Fleet compaction backoff: unavailable, Pi retries as it does. ${reason}`);
  }
}

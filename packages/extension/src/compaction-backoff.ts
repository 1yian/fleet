import { readFileSync } from "node:fs";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { methodOf, once } from "./patch.ts";
import { routerResumeAt } from "./router-cooldown.ts";

const FIRST_DELAY_MS = 30_000;
const LONGEST_DELAY_MS = 30 * 60_000;

let failures = 0;
let retryAt = 0;

function now(): number {
  const file = process.env["FLEET_CLOCK_FILE"];
  if (file === undefined) return Date.now();
  const at = Date.parse(readFileSync(file, "utf8"));
  return Number.isFinite(at) ? at : Date.now();
}

export function compactionFailed(error: string): void {
  const at = now();
  failures += 1;
  const delay = Math.min(FIRST_DELAY_MS * 2 ** (failures - 1), LONGEST_DELAY_MS);
  retryAt = routerResumeAt(error, at) ?? at + delay;
}

export function compactionSucceeded(): void {
  failures = 0;
  retryAt = 0;
}

export function applyCompactionBackoff(): void {
  once("compaction-backoff", () => {
    try {
      const run = methodOf(AgentSession.prototype, "_runAutoCompaction");
      Reflect.set(
        AgentSession.prototype,
        "_runAutoCompaction",
        function (this: object, ...args: unknown[]) {
          return now() < retryAt ? Promise.resolve(false) : run(this, ...args);
        },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Fleet compaction backoff: unavailable, Pi retries as it does. ${reason}`);
    }
  });
}

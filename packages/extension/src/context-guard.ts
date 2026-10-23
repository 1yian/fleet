import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Blockage } from "./blockage.ts";
import { MATE_CONTEXT_CAP } from "./context-policy.ts";
import { isRecord } from "./lane-config.ts";

export const BLOCKED_LABEL = "blocked: context over 400K, waiting for compaction";
export const COMPACTOR_EVENT = "fleet:compactor";

const RETRY_MS = Number(process.env["FLEET_COMPACTION_RETRY_MS"]) || 60_000;
const CHARS_PER_TOKEN = 4;

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum: number, part) => sum + textLength(part), 0);
  if (!isRecord(value)) return 0;
  return Object.values(value).reduce((sum: number, part) => sum + textLength(part), 0);
}

function reportedTokens(message: unknown): number {
  if (!isRecord(message) || message["role"] !== "assistant") return 0;
  if (message["stopReason"] === "error" || message["stopReason"] === "aborted") return 0;
  const usage = message["usage"];
  if (!isRecord(usage)) return 0;
  const total = usage["totalTokens"];
  if (typeof total === "number" && total > 0) return total;
  return ["input", "output", "cacheRead", "cacheWrite"].reduce((sum, field) => {
    const part = usage[field];
    return sum + (typeof part === "number" ? part : 0);
  }, 0);
}

export function contextTokens(messages: readonly unknown[]): number {
  const last = messages.findLastIndex((message) => reportedTokens(message) > 0);
  const known = last < 0 ? 0 : reportedTokens(messages[last]);
  const rest = messages.slice(last + 1);
  return known + Math.ceil(textLength(rest) / CHARS_PER_TOKEN);
}

export default function contextGuard(pi: ExtensionAPI): void {
  const blockage = new Blockage(pi);
  let compactionDown = false;
  let refused = false;
  let waiting = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let compact: (() => void) | undefined;

  const resume = (): void => {
    if (!waiting) return;
    waiting = false;
    refused = false;
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
    blockage.release();
    pi.sendMessage(
      {
        customType: "fleet-compaction",
        content:
          "[fleet] compaction: the conversation compacted, so the request that waited goes out now.",
        display: true,
      },
      { triggerTurn: true },
    );
  };

  const healed = (): void => {
    compactionDown = false;
    resume();
  };

  const scheduleRetry = (): void => {
    if (retry !== undefined || !waiting) return;
    retry = setTimeout(() => {
      retry = undefined;
      compact?.();
      scheduleRetry();
    }, RETRY_MS);
    retry.unref();
  };

  pi.events.on(COMPACTOR_EVENT, (data) => {
    if (!isRecord(data)) return;
    if (data["healthy"] === true) healed();
    else compactionDown = true;
  });
  pi.on("session_compact_failed", (event) => {
    if (!event.aborted) compactionDown = true;
  });
  pi.on("session_compact", healed);
  pi.on("agent_start", () => {
    refused = false;
    blockage.release();
  });
  pi.on("session_shutdown", () => {
    if (retry !== undefined) clearTimeout(retry);
  });
  pi.on("agent_settled", () => {
    if (!refused) return;
    blockage.raise(BLOCKED_LABEL, blockage.now);
  });

  pi.on("context_with_system", (event, ctx: ExtensionContext) => {
    if (!compactionDown || contextTokens(event.messages) <= MATE_CONTEXT_CAP) return undefined;
    refused = true;
    waiting = true;
    compact = () => {
      ctx.compact();
    };
    scheduleRetry();
    ctx.abort();
    return undefined;
  });
}

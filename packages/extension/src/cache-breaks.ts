import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./lane-config.ts";

const CACHE_BREAK_ENTRY = "fleet-cache-break";
const STATUS_KEY = "fleet-cache-breaks";

const BREAK_BELOW_SHARE = 0.5;
const MIN_PRIOR_TOKENS = 1024;
const DEFAULT_TTL_SECONDS = 300;
const TAIL_MARK = "\u2063fleet-mutable-tail\u2063";

type CacheBreakCause = "model" | "compaction" | "system-prompt" | "tools" | "idle" | "other";

interface Fingerprint {
  readonly system: string;
  readonly tools: string;
  readonly toolCount: number;
}

interface Previous {
  readonly provider: string;
  readonly model: string;
  readonly cached: number;
  readonly endedAt: number;
  readonly fingerprint: Fingerprint | undefined;
}

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, item]) => [key, withoutCacheControl(item)]),
  );
}

function textOf(block: unknown): string {
  if (typeof block === "string") return block;
  return isRecord(block) && typeof block["text"] === "string" ? block["text"] : "";
}

function stableSystem(payload: Record<string, unknown>): string {
  const raw = payload["system"] ?? payload["instructions"] ?? "";
  const blocks: unknown[] = Array.isArray(raw) ? raw : [raw];
  const marked = blocks.map((block) => isRecord(block) && isRecord(block["cache_control"]));
  const head = marked.indexOf(true);
  const text = blocks
    .slice(0, head < 0 ? blocks.length : head + 1)
    .map(textOf)
    .join("\n");
  return text.split(TAIL_MARK)[0] ?? "";
}

function fingerprintOf(payload: unknown): Fingerprint | undefined {
  if (!isRecord(payload)) return undefined;
  const tools: unknown[] = Array.isArray(payload["tools"]) ? payload["tools"] : [];
  return {
    system: digest(stableSystem(payload)),
    tools: digest(withoutCacheControl(tools)),
    toolCount: tools.length,
  };
}

function causeOf(facts: {
  readonly switched: boolean;
  readonly compacted: boolean;
  readonly now: Fingerprint | undefined;
  readonly before: Fingerprint | undefined;
  readonly idleSeconds: number;
  readonly ttlSeconds: number;
}): CacheBreakCause {
  if (facts.switched) return "model";
  if (facts.compacted) return "compaction";
  if (facts.now !== undefined && facts.before !== undefined) {
    if (facts.now.system !== facts.before.system) return "system-prompt";
    if (facts.now.tools !== facts.before.tools) return "tools";
  }
  return facts.idleSeconds > facts.ttlSeconds ? "idle" : "other";
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function statusText(count: number, cause: string): string {
  return `cache breaks ${String(count)} (last: ${cause})`;
}

interface Tally {
  count: number;
  last: string;
}

function tallyOf(ctx: ExtensionContext): Tally {
  const tally: Tally = { count: 0, last: "" };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== CACHE_BREAK_ENTRY) continue;
    const data: unknown = entry.data;
    tally.count += 1;
    if (isRecord(data) && typeof data["cause"] === "string") tally.last = data["cause"];
  }
  return tally;
}

interface Sent {
  readonly fingerprint: Fingerprint | undefined;
  readonly at: number;
}

interface Answer {
  readonly provider: string;
  readonly model: string;
  readonly read: number;
  readonly cached: number;
}

const textField = (message: Record<string, unknown>, key: string): string => {
  const value = message[key];
  return typeof value === "string" ? value : "";
};

function answerOf(message: unknown): Answer | undefined {
  if (!isRecord(message) || message["role"] !== "assistant") return undefined;
  const usage = message["usage"];
  if (!isRecord(usage)) return undefined;
  if (message["stopReason"] === "error" || message["stopReason"] === "aborted") return undefined;
  const read = numberOf(usage["cacheRead"]);
  return {
    provider: textField(message, "provider"),
    model: textField(message, "model"),
    read,
    cached: read + numberOf(usage["cacheWrite"]),
  };
}

function detailsOf(
  before: Previous,
  answer: Answer,
  fingerprint: Fingerprint | undefined,
): Record<string, unknown> {
  return {
    provider: answer.provider,
    model: answer.model,
    previousProvider: before.provider,
    previousModel: before.model,
    cacheRead: answer.read,
    previousCached: before.cached,
    systemHash: fingerprint?.system,
    toolsHash: fingerprint?.tools,
    toolCount: fingerprint?.toolCount,
  };
}

class CacheBreakLog {
  private tally: Tally;
  private previous: Previous | undefined;
  private sent: Sent | undefined;
  private compacted = false;

  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI, started: ExtensionContext) {
    this.pi = pi;
    this.tally = tallyOf(started);
    this.show(started);
  }

  restart(ctx: ExtensionContext): void {
    this.tally = tallyOf(ctx);
    this.previous = undefined;
    this.sent = undefined;
    this.compacted = false;
    this.show(ctx);
  }

  request(payload: unknown): void {
    this.sent = { fingerprint: fingerprintOf(payload), at: Date.now() };
  }

  compaction(): void {
    this.compacted = true;
  }

  answer(message: unknown, ctx: ExtensionContext): void {
    const answer = answerOf(message);
    if (answer === undefined) return;
    const now = Date.now();
    const sent = this.sent;
    this.sent = undefined;
    const before = this.previous;
    const compacted = this.compacted;
    this.compacted = false;
    this.previous = {
      provider: answer.provider,
      model: answer.model,
      cached: answer.cached,
      endedAt: now,
      fingerprint: sent?.fingerprint,
    };
    const broke =
      before !== undefined &&
      before.cached >= MIN_PRIOR_TOKENS &&
      answer.read < before.cached * BREAK_BELOW_SHARE;
    if (broke) this.record(ctx, { before, answer, sent, compacted, now });
  }

  private record(
    ctx: ExtensionContext,
    seen: {
      before: Previous;
      answer: Answer;
      sent: Sent | undefined;
      compacted: boolean;
      now: number;
    },
  ): void {
    const { before, answer, sent, compacted, now } = seen;
    const ttl = ctx.model?.promptCache?.short ?? DEFAULT_TTL_SECONDS;
    const idleSeconds = ((sent?.at ?? now) - before.endedAt) / 1000;
    const cause = causeOf({
      switched: before.provider !== answer.provider || before.model !== answer.model,
      compacted,
      now: sent?.fingerprint,
      before: before.fingerprint,
      idleSeconds,
      ttlSeconds: ttl,
    });
    this.tally = { count: this.tally.count + 1, last: cause };
    this.pi.appendEntry(CACHE_BREAK_ENTRY, {
      at: new Date(now).toISOString(),
      cause,
      count: this.tally.count,
      idleSeconds: Math.round(idleSeconds),
      ttlSeconds: ttl,
      ...detailsOf(before, answer, sent?.fingerprint),
    });
    this.show(ctx);
  }

  private show(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      STATUS_KEY,
      this.tally.count > 0 ? statusText(this.tally.count, this.tally.last) : undefined,
    );
  }
}

export function applyCacheBreakLog(pi: ExtensionAPI, started: ExtensionContext): void {
  const log = new CacheBreakLog(pi, started);
  pi.on("before_provider_request", (event) => {
    log.request(event.payload);
    return undefined;
  });
  pi.on("session_start", (_event, ctx) => {
    log.restart(ctx);
  });
  pi.on("session_compact", () => {
    log.compaction();
  });
  pi.on("message_end", (event, ctx) => {
    log.answer(event.message, ctx);
  });
}

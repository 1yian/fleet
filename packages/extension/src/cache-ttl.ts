import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STABLE_TTL = "1h";
const MAX_BREAKPOINTS = 4;

type Block = Record<string, unknown>;

function isBlock(value: unknown): value is Block {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocksOf(value: unknown): Block[] {
  return Array.isArray(value) ? value.filter(isBlock) : [];
}

function systemOf(payload: Block): Block[] {
  const system = payload["system"];
  if (typeof system === "string" && system.length > 0)
    payload["system"] = [{ type: "text", text: system }];
  return blocksOf(payload["system"]);
}

function marked(blocks: Block[]): Block[] {
  return blocks.filter((block) => isBlock(block["cache_control"]));
}

function splitMateCacheTtl(payload: unknown): unknown {
  if (!isBlock(payload) || !Array.isArray(payload["messages"])) return payload;
  const systemBlocks = systemOf(payload);
  const last = systemBlocks[systemBlocks.length - 1];
  if (last === undefined) return payload;

  const tools = blocksOf(payload["tools"]);
  const messages = blocksOf(payload["messages"]);
  const messageBlocks = messages.flatMap((message) => [message, ...blocksOf(message["content"])]);
  for (const block of [...systemBlocks, ...tools]) delete block["cache_control"];
  last["cache_control"] = { type: "ephemeral", ttl: STABLE_TTL };

  const view = marked(messageBlocks);
  for (const block of view) {
    const control = block["cache_control"];
    if (isBlock(control)) delete control["ttl"];
  }
  const topLevel = isBlock(payload["cache_control"]) ? 1 : 0;
  const excess = 1 + topLevel + view.length - MAX_BREAKPOINTS;
  for (const block of view.slice(0, Math.max(0, excess))) delete block["cache_control"];
  return payload;
}

export default function cacheTtl(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event) => splitMateCacheTtl(event.payload));
}

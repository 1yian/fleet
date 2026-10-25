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

export const MUTABLE_TAIL = "\u2063fleet-mutable-tail\u2063";

function splitTail(payload: Block, blocks: Block[]): Block[] {
  const at = blocks.findIndex((block) => String(block["text"]).includes(MUTABLE_TAIL));
  const block = blocks[at];
  if (block === undefined) return blocks.slice(-1);
  const [head = "", ...rest] = String(block["text"]).split(MUTABLE_TAIL);
  const tail = rest.join("");
  const parts: Block[] = [{ ...block, text: head }];
  if (tail.trim() !== "") parts.push({ type: "text", text: tail });
  payload["system"] = [...blocks.slice(0, at), ...parts, ...blocks.slice(at + 1)];
  return parts;
}

function marked(blocks: Block[]): Block[] {
  return blocks.filter((block) => isBlock(block["cache_control"]));
}

function splitMateCacheTtl(payload: unknown): unknown {
  if (!isBlock(payload) || !Array.isArray(payload["messages"])) return payload;
  systemOf(payload);
  const stable = splitTail(payload, blocksOf(payload["system"]));
  const systemBlocks = blocksOf(payload["system"]);
  if (stable.length === 0) return payload;

  const tools = blocksOf(payload["tools"]);
  const messages = blocksOf(payload["messages"]);
  const messageBlocks = messages.flatMap((message) => [message, ...blocksOf(message["content"])]);
  for (const block of [...systemBlocks, ...tools]) delete block["cache_control"];
  for (const block of stable) block["cache_control"] = { type: "ephemeral", ttl: STABLE_TTL };

  for (const block of marked(messageBlocks))
    block["cache_control"] = { type: "ephemeral", ttl: STABLE_TTL };
  const view = marked(messageBlocks);
  const topLevel = isBlock(payload["cache_control"]) ? 1 : 0;
  const excess = stable.length + topLevel + view.length - MAX_BREAKPOINTS;
  for (const block of view.slice(0, Math.max(0, excess))) delete block["cache_control"];
  return payload;
}

export default function cacheTtl(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event) => splitMateCacheTtl(event.payload));
}

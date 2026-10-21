import { isRecord, optionalString, type JsonRecord } from "./json.ts";

export interface WireCall {
  readonly role: "mate" | "worker";
  readonly warm: boolean;
  readonly ttls: readonly string[];
  readonly turns: readonly { readonly role: string; readonly text: string }[];
}

export type WireMove =
  | { readonly text: string; readonly thinking?: string }
  | { readonly texts: readonly string[]; readonly thinking?: string }
  | { readonly tool: string; readonly args?: Readonly<Record<string, string | number | boolean>> };

const PROMPT_TOKENS = 100_000;

const WORKER_CONTRACT = "# Worker role contract";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .map((block) => optionalString(block, "text") ?? textOf(block["content"]))
    .join("");
}

function ttlsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(ttlsIn);
  if (!isRecord(value)) return [];
  const own = isRecord(value["cache_control"])
    ? [optionalString(value["cache_control"], "ttl") ?? "default"]
    : [];
  return [...own, ...Object.values(value).flatMap(ttlsIn)];
}

function turnsOf(body: JsonRecord): WireCall["turns"] {
  const system = textOf(body["system"]);
  const messages = Array.isArray(body["messages"]) ? body["messages"].filter(isRecord) : [];
  return [
    { role: "system", text: system },
    ...messages.map((message) => {
      const blocks = Array.isArray(message["content"]) ? message["content"].filter(isRecord) : [];
      const isResult = blocks.some((block) => block["type"] === "tool_result");
      return {
        role: isResult ? "toolResult" : (optionalString(message, "role") ?? ""),
        text: textOf(message["content"]),
      };
    }),
  ];
}

export function wireCall(body: JsonRecord): WireCall {
  const turns = turnsOf(body);
  return {
    role: turns[0]?.text.includes(WORKER_CONTRACT) === true ? "worker" : "mate",
    warm: body["max_tokens"] === 1,
    ttls: ttlsIn(body),
    turns,
  };
}

function event(name: string, data: JsonRecord): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function spokenBy(move: WireMove): string {
  if ("texts" in move) return move.texts.join("");
  return "text" in move ? move.text : "";
}

export function stream(move: WireMove): string {
  const usage = { input_tokens: PROMPT_TOKENS, output_tokens: 1 };
  const block =
    "tool" in move
      ? { type: "tool_use", id: "toolu_1", name: move.tool, input: {} }
      : { type: "text", text: "" };
  const delta =
    "tool" in move
      ? { type: "input_json_delta", partial_json: JSON.stringify(move.args ?? {}) }
      : { type: "text_delta", text: spokenBy(move) };
  return [
    event("message_start", {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", content: [], usage },
    }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: block }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool" in move ? "tool_use" : "end_turn" },
      usage: { output_tokens: 1 },
    }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
}

import { appendFileSync, writeFileSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type AssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord, optionalString, parseRecord } from "./json.ts";

const CALLS = 10_000;

function controlUrl(): string {
  const url = process.env["FLEET_CONTROL_URL"];
  if (url === undefined) throw new Error("FLEET_CONTROL_URL is not set");
  return url;
}

function scalarArgs(value: unknown): Record<string, string | number | boolean | readonly string[]> {
  if (!isRecord(value)) return {};
  const args: Record<string, string | number | boolean | readonly string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean")
      args[key] = item;
    else if (Array.isArray(item) && item.every((each) => typeof each === "string"))
      args[key] = item;
  }
  return args;
}

function toMessage(move: Record<string, unknown>): AssistantMessage {
  const tool = optionalString(move, "tool");
  const text = optionalString(move, "text");
  if (tool !== undefined) {
    const thought = optionalString(move, "thinking");
    const thinking = thought === undefined ? [] : [fauxThinking(thought)];
    const note = text === undefined ? [] : [fauxText(text)];
    return fauxAssistantMessage(
      [...thinking, ...note, fauxToolCall(tool, scalarArgs(move["args"]))],
      {
        stopReason: "toolUse",
      },
    );
  }
  const thinking = optionalString(move, "thinking");
  const texts = move["texts"];
  const blocks = Array.isArray(texts)
    ? texts.filter((each) => typeof each === "string").map(fauxText)
    : [fauxText(text ?? "")];
  return fauxAssistantMessage(
    thinking === undefined ? blocks : [fauxThinking(thinking), ...blocks],
  );
}

const respond: FauxResponseFactory = async (context, options, _state, model) => {
  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fake-agent": process.env["FLEET_FAKE_AGENT"] ?? "default",
      "x-fake-model": `${model.provider}/${model.id}`,
    },
    body: JSON.stringify({ messages: context.messages }),
  };
  if (options?.signal !== undefined) init.signal = options.signal;
  const response = await fetch(`${controlUrl()}/model`, init);
  const body = await response.text();
  if (!response.ok) throw new Error(body);
  return toMessage(parseRecord(body));
};

export default function fakeModel(pi: ExtensionAPI): void {
  const argvFile = process.env["FLEET_ARGV_FILE"];
  if (argvFile !== undefined) writeFileSync(argvFile, `${process.argv.join("\n")}\n`);
  const missing = new Set((process.env["FLEET_FAKE_MISSING"] ?? "").split(",").filter(Boolean));
  const present = (provider: string, models: { id: string }[]): { id: string }[] =>
    models.filter((model) => !missing.has(`${provider}/${model.id}`));
  const avoidFile = process.env["FLEET_AVOID_FILE"];
  if (avoidFile !== undefined)
    pi.on("session_start", () => {
      appendFileSync(avoidFile, `${process.env["PI_TIERS_AVOID"] ?? "(unset)"}\n`);
    });
  const providers = [
    fauxProvider({ provider: "fake", models: [{ id: "scripted" }] }),
    fauxProvider({
      provider: "google-vertex",
      models: present("google-vertex", [{ id: "gemini-2.5-pro" }, { id: "gemini-3.8-flash" }]),
    }),
    fauxProvider({
      provider: "vertex-claude",
      models: present("vertex-claude", [{ id: "claude-haiku-5-5" }]),
    }),
    fauxProvider({
      provider: "tier",
      models: [
        { id: "orchestrator" },
        { id: "weaker-orchestrator" },
        { id: "auto" },
        { id: "quick" },
        { id: "compact" },
      ],
    }),
  ];
  for (const faux of providers) {
    if (faux.models.length === 0) continue;
    faux.setResponses(Array.from({ length: CALLS }, () => respond));
    pi.registerProvider(faux.provider);
  }
}

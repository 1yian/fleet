// Pi extension: a scripted model. Each model call posts the transcript to the
// test's control server and returns the move that the test chooses. Every
// other mechanism in Pi stays real. Besides fake/scripted, it answers as the
// captain's tiers (tier/orchestrator, tier/auto, tier/quick), so a test can see
// which model a Pi chose from its settings.
import { writeFileSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
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

/** Tool arguments from the test: an object of strings, numbers, and booleans. */
function scalarArgs(value: unknown): Record<string, string | number | boolean> {
  if (!isRecord(value)) return {};
  const args: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean")
      args[key] = item;
  }
  return args;
}

function toMessage(move: Record<string, unknown>): AssistantMessage {
  const tool = optionalString(move, "tool");
  const text = optionalString(move, "text");
  if (tool !== undefined) {
    // A tool call may follow a short note, as a real model's does.
    const note = text === undefined ? [] : [fauxText(text)];
    return fauxAssistantMessage([...note, fauxToolCall(tool, scalarArgs(move["args"]))], {
      stopReason: "toolUse",
    });
  }
  return fauxAssistantMessage([fauxText(text ?? "")]);
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
  return toMessage(parseRecord(await response.text()));
};

export default function fakeModel(pi: ExtensionAPI): void {
  const argvFile = process.env["FLEET_ARGV_FILE"];
  if (argvFile !== undefined) writeFileSync(argvFile, `${process.argv.join("\n")}\n`);
  const providers = [
    fauxProvider({ provider: "fake", models: [{ id: "scripted" }] }),
    fauxProvider({
      provider: "tier",
      models: [{ id: "orchestrator" }, { id: "auto" }, { id: "quick" }],
    }),
  ];
  for (const faux of providers) {
    faux.setResponses(Array.from({ length: CALLS }, () => respond));
    pi.registerProvider(faux.provider);
  }
}

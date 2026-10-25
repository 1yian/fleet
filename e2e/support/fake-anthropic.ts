import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROMPT_TOKENS_COST = { input: 300, output: 15, cacheRead: 30, cacheWrite: 375 };
const SHORT_LIFETIME_SECONDS = 12;
const LONG_LIFETIME_SECONDS = 15;

function controlUrl(): string {
  const url = process.env["FLEET_CONTROL_URL"];
  if (url === undefined) throw new Error("FLEET_CONTROL_URL is not set");
  return url;
}

export default function fakeAnthropic(pi: ExtensionAPI): void {
  const model = (
    id: string,
    contextWindow = 1_000_000,
  ): Parameters<ExtensionAPI["registerProvider"]>[1]["models"] => [
    {
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: PROMPT_TOKENS_COST,
      contextWindow,
      maxTokens: 4096,
      promptCache: { short: SHORT_LIFETIME_SECONDS, long: LONG_LIFETIME_SECONDS },
    },
  ];
  pi.registerProvider("tier", {
    baseUrl: `${controlUrl()}/anthropic`,
    apiKey: "scripted",
    api: "anthropic-messages",
    headers: { "x-fake-agent": process.env["FLEET_FAKE_AGENT"] ?? "default" },
    models: [
      ...["orchestrator", "auto", "quick"].flatMap((id) => model(id) ?? []),
      ...(model("small", 200_000) ?? []),
    ],
  });
  pi.registerProvider("vertex-claude", {
    baseUrl: `${controlUrl()}/anthropic`,
    apiKey: "scripted",
    api: "vertex-claude-api",
    headers: { "x-fake-agent": process.env["FLEET_FAKE_AGENT"] ?? "default" },
    streamSimple: (target, context, options) =>
      streamSimple(
        { ...target, api: "anthropic-messages", compat: { supportsLongCacheRetention: true } },
        context,
        options,
      ),
    models: model("auto") ?? [],
  });
  let routes = 0;
  pi.registerVirtualModel({
    provider: "tier",
    id: "routed",
    name: "routed",
    thinkingLevels: ["off"],
    route: (_request, ctx) => {
      const physical = ctx.modelRegistry.find("tier", "auto");
      if (physical === undefined) throw new Error("tier/auto is not registered");
      return { model: physical, thinkingLevel: "off" };
    },
  });
  pi.registerVirtualModel({
    provider: "tier",
    id: "swing",
    name: "swing",
    thinkingLevels: ["off"],
    route: (_request, ctx) => {
      routes += 1;
      const id = routes === 1 ? "auto" : "small";
      const physical = ctx.modelRegistry.find("tier", id);
      if (physical === undefined) throw new Error(`tier/${id} is not registered`);
      return { model: physical, thinkingLevel: "off" };
    },
  });
}

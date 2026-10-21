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
  const model = (id: string): Parameters<ExtensionAPI["registerProvider"]>[1]["models"] => [
    {
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: PROMPT_TOKENS_COST,
      contextWindow: 100_000_000,
      maxTokens: 4096,
      promptCache: { short: SHORT_LIFETIME_SECONDS, long: LONG_LIFETIME_SECONDS },
    },
  ];
  pi.registerProvider("tier", {
    baseUrl: `${controlUrl()}/anthropic`,
    apiKey: "scripted",
    api: "anthropic-messages",
    headers: { "x-fake-agent": process.env["FLEET_FAKE_AGENT"] ?? "default" },
    models: ["orchestrator", "auto", "quick"].flatMap((id) => model(id) ?? []),
  });
}

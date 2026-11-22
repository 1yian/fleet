import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const TIERS_TEMPLATE = fileURLToPath(new URL("../templates/tiers.json", import.meta.url));
export const NO_MISTAKES_TEMPLATE = fileURLToPath(
  new URL("../templates/no-mistakes.yaml", import.meta.url),
);

export function piAgentDir(): string {
  const set = process.env["PI_CODING_AGENT_DIR"];
  if (set === undefined || set === "") return join(homedir(), ".pi", "agent");
  return set === "~" || set.startsWith("~/") ? join(homedir(), set.slice(1)) : set;
}

export function tiersConfigPath(): string {
  const set = process.env["PI_TIERS_CONFIG"];
  return set === undefined || set === "" ? join(piAgentDir(), "tiers.json") : set;
}

export function readTiersConfig(): unknown {
  try {
    return JSON.parse(readFileSync(tiersConfigPath(), "utf8"));
  } catch {
    return undefined;
  }
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function usableRung(rung: unknown): boolean {
  if (typeof rung !== "string") return false;
  const slash = rung.indexOf("/");
  if (slash <= 0) return false;
  let model = rung.slice(slash + 1);
  const colon = model.lastIndexOf(":");
  if (colon > 0 && THINKING_LEVELS.includes(model.slice(colon + 1))) model = model.slice(0, colon);
  return model !== "";
}

function tierEntries(config: unknown): [string, unknown][] {
  const tiers: unknown = Reflect.get(Object(config), "tiers");
  if (typeof tiers !== "object" || tiers === null || Array.isArray(tiers)) return [];
  return Object.entries(tiers);
}

export const declaredTiers = (config: unknown): string[] =>
  tierEntries(config).flatMap(([name, tier]) => {
    const chain: unknown = Reflect.get(Object(tier), "chain");
    return Array.isArray(chain) && chain.length > 0 && chain.every(usableRung) ? [name] : [];
  });

export const requiredTiers = (): string[] =>
  tierEntries(JSON.parse(readFileSync(TIERS_TEMPLATE, "utf8"))).map(([name]) => name);

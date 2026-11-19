import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const TIERS_TEMPLATE = fileURLToPath(new URL("../templates/tiers.json", import.meta.url));
export const NO_MISTAKES_TEMPLATE = fileURLToPath(
  new URL("../templates/no-mistakes.yaml", import.meta.url),
);

function piAgentDir(): string {
  const set = process.env["PI_CODING_AGENT_DIR"];
  if (set === undefined || set === "") return join(homedir(), ".pi", "agent");
  return set === "~" || set.startsWith("~/") ? join(homedir(), set.slice(1)) : set;
}

export const tiersConfigPath = (): string =>
  process.env["PI_TIERS_CONFIG"] ?? join(piAgentDir(), "tiers.json");

export function readTiersConfig(): unknown {
  try {
    return JSON.parse(readFileSync(tiersConfigPath(), "utf8"));
  } catch {
    return undefined;
  }
}

export function declaredTiers(config: unknown): string[] {
  const tiers: unknown = Reflect.get(Object(config), "tiers");
  if (typeof tiers !== "object" || tiers === null || Array.isArray(tiers)) return [];
  return Object.entries(tiers).flatMap(([name, tier]) => {
    const chain: unknown = Reflect.get(Object(tier), "chain");
    const usable =
      Array.isArray(chain) &&
      chain.length > 0 &&
      chain.every((rung) => typeof rung === "string" && rung !== "");
    return usable ? [name] : [];
  });
}

export const requiredTiers = (): string[] =>
  declaredTiers(JSON.parse(readFileSync(TIERS_TEMPLATE, "utf8")));

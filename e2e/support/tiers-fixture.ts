import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TIERS_TEMPLATE = fileURLToPath(
  new URL("../../packages/extension/templates/tiers.json", import.meta.url),
);

export function seedTiers(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true });
  copyFileSync(TIERS_TEMPLATE, join(agentDir, "tiers.json"));
}

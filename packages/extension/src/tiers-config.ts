import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function readTiersConfig(): unknown {
  try {
    const path = process.env["PI_TIERS_CONFIG"] ?? join(getAgentDir(), "tiers.json");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

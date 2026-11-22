import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BrokerConfig {
  socket: string;
  opPath: string;
  tokenFile: string;
  stateDir: string;
  dailyReadBudget: number;
  sourceVault: string;
  lanes: Record<string, string[]>;
}

const DEFAULT_BROKER_CONFIG_PATH = "/etc/fleet-browser-broker/config.json";
export const LANE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VAULT_PREFIX = "fleet-browser-";

export function laneVaultName(lane: string): string {
  return `${VAULT_PREFIX}${lane}`;
}

function parseLanes(raw: unknown): Record<string, string[]> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("broker config: lanes must be an object of lane name to a list of item titles");
  }
  const lanes: Record<string, string[]> = {};
  for (const [lane, titles] of Object.entries(raw)) {
    if (!LANE_PATTERN.test(lane)) throw new Error(`broker config: invalid lane name ${lane}`);
    if (!Array.isArray(titles) || titles.some((t) => typeof t !== "string" || t.trim() === "")) {
      throw new Error(`broker config: lane ${lane} must list non-empty item titles`);
    }
    if (new Set(titles).size !== titles.length)
      throw new Error(`broker config: lane ${lane} lists a title twice`);
    lanes[lane] = titles as string[];
  }
  return lanes;
}

export function loadBrokerConfig(
  path: string = process.env.FLEET_BROWSER_BROKER_CONFIG ?? DEFAULT_BROKER_CONFIG_PATH,
): BrokerConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const text = (key: string, fallback: string): string =>
    typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string) : fallback;
  const budget = raw.dailyReadBudget;
  const credentials = process.env.CREDENTIALS_DIRECTORY;
  const tokenFile = text("tokenFile", credentials ? join(credentials, "op-token") : "");
  if (tokenFile === "") {
    throw new Error(
      "broker config: no token file (start through the systemd unit, which loads it as a credential)",
    );
  }
  const sourceVault = text("sourceVault", "Personal");
  if (sourceVault.startsWith(VAULT_PREFIX)) {
    throw new Error(`broker config: sourceVault must not be a ${VAULT_PREFIX}* lane vault`);
  }
  return {
    socket: text("socket", "/run/fleet-browser-broker/broker.sock"),
    opPath: text("opPath", "/usr/local/bin/op"),
    tokenFile,
    stateDir: text("stateDir", "/var/lib/fleet-browser-broker"),
    dailyReadBudget: typeof budget === "number" && budget > 0 ? budget : 800,
    sourceVault,
    lanes: parseLanes(raw.lanes),
  };
}

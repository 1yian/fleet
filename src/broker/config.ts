import { readFileSync } from "node:fs";

export interface BrokerConfig {
  socket: string;
  opPath: string;
  tokenDir: string;
  stateDir: string;
  dailyReadBudget: number;
}

export const DEFAULT_BROKER_CONFIG_PATH = "/etc/fleet-browser-broker/config.json";

export function loadBrokerConfig(
  path: string = process.env.FLEET_BROWSER_BROKER_CONFIG ?? DEFAULT_BROKER_CONFIG_PATH,
): BrokerConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const text = (key: string, fallback: string): string =>
    typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string) : fallback;
  const budget = raw.dailyReadBudget;
  return {
    socket: text("socket", "/run/fleet-browser-broker/broker.sock"),
    opPath: text("opPath", "/usr/local/bin/op"),
    tokenDir: text("tokenDir", "/etc/fleet-browser-broker/tokens"),
    stateDir: text("stateDir", "/var/lib/fleet-browser-broker"),
    dailyReadBudget: typeof budget === "number" && budget > 0 ? budget : 800,
  };
}

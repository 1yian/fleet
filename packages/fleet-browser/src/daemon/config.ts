import { readFileSync } from "node:fs";

export interface Config {
  chrome: { path: string; version: string };
  dataDir: string;
  agent: { host: string; port: number };
  stream: { host: string; port: number; tokenDir: string };
  lanes: {
    max: number;
    cpusPerLane: number;
    totalCpus: number;
    firstDisplay: number;
    firstCdpPort: number;
    screen: { width: number; height: number };
  };
  broker: { socket: string };
  notify: { url: string; topicFile: string } | null;
  captcha: { dir: string; keyFile: string; model: string | null; budgetSeconds: number } | null;
  handoff: { defaultWaitSeconds: number; linkTemplate: string | null };
}

export const DEFAULT_CONFIG_PATH = "/etc/fleet-browser/config.json";

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`config ${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value === "")
    throw new Error(`config ${where}.${key} must be a non-empty string`);
  return value;
}

function num(obj: Record<string, unknown>, key: string, where: string, fallback?: number): number {
  const value = obj[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`config ${where}.${key} must be a number`);
  return value;
}

export function parseConfig(raw: unknown): Config {
  const root = record(raw, "root");
  const chrome = record(root.chrome, "chrome");
  const agent = record(root.agent ?? {}, "agent");
  const stream = record(root.stream, "stream");
  const lanes = record(root.lanes ?? {}, "lanes");
  const screen = record(lanes.screen ?? {}, "lanes.screen");
  const handoff = record(root.handoff ?? {}, "handoff");
  const broker = record(root.broker ?? {}, "broker");
  const notify = root.notify === undefined ? null : record(root.notify, "notify");
  const captcha = root.captcha === undefined ? null : record(root.captcha, "captcha");
  const linkTemplate = handoff.linkTemplate ?? null;
  if (linkTemplate !== null && (typeof linkTemplate !== "string" || !linkTemplate.includes("{lane}"))) {
    throw new Error("config handoff.linkTemplate must be a string containing {lane}");
  }
  return {
    chrome: { path: str(chrome, "path", "chrome"), version: str(chrome, "version", "chrome") },
    dataDir: typeof root.dataDir === "string" ? root.dataDir : "/var/lib/fleet-browser",
    agent: {
      host: typeof agent.host === "string" ? agent.host : "127.0.0.1",
      port: num(agent, "port", "agent", 7620),
    },
    stream: {
      host: str(stream, "host", "stream"),
      port: num(stream, "port", "stream", 7621),
      tokenDir: str(stream, "tokenDir", "stream"),
    },
    lanes: {
      max: num(lanes, "max", "lanes", 24),
      cpusPerLane: num(lanes, "cpusPerLane", "lanes", 8),
      totalCpus: num(lanes, "totalCpus", "lanes", 128),
      firstDisplay: num(lanes, "firstDisplay", "lanes", 121),
      firstCdpPort: num(lanes, "firstCdpPort", "lanes", 9321),
      screen: {
        width: num(screen, "width", "lanes.screen", 1440),
        height: num(screen, "height", "lanes.screen", 900),
      },
    },
    broker: {
      socket: typeof broker.socket === "string" ? broker.socket : "/run/fleet-browser-broker/broker.sock",
    },
    notify: notify
      ? { url: str(notify, "url", "notify"), topicFile: str(notify, "topicFile", "notify") }
      : null,
    captcha: captcha
      ? {
          dir: str(captcha, "dir", "captcha"),
          keyFile: str(captcha, "keyFile", "captcha"),
          model: typeof captcha.model === "string" && captcha.model !== "" ? captcha.model : null,
          budgetSeconds: num(captcha, "budgetSeconds", "captcha", 150),
        }
      : null,
    handoff: {
      defaultWaitSeconds: num(handoff, "defaultWaitSeconds", "handoff", 1800),
      linkTemplate: linkTemplate as string | null,
    },
  };
}

export function loadConfig(path: string = process.env.FLEET_BROWSER_CONFIG ?? DEFAULT_CONFIG_PATH): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

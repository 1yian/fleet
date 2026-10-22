import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface CarddConfig {
  readonly host: string;
  readonly root: string;
  readonly db: string;
  readonly restart: readonly string[];
}

export interface Costs {
  readonly mateCacheRetention: "short" | "long";
  readonly digestMinutes: number;
  readonly workerContextCap: number;
}

export const DEFAULT_COSTS: Costs = {
  mateCacheRetention: "short",
  digestMinutes: 5,
  workerContextCap: 250_000,
};

export interface LaneConfig {
  readonly lane: string;
  readonly url: string;
  readonly token: string;
  readonly host?: string;
  readonly hosts: Record<string, unknown>;
  readonly roots: Record<string, string>;
  readonly args: readonly string[];
  readonly workerArgs: readonly string[];
  readonly direnv?: string;
  readonly cardd?: CarddConfig;
  readonly costs: Costs;
}

export const LANE_FILE = join("config", "lane.json");

type Json = Record<string, unknown>;
export const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each) => typeof each === "string") : [];

function direnvFolder(file: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const folder = typeof value === "string" ? value.replace(/^~(?=\/|$)/, homedir()) : "";
  if (!isAbsolute(folder)) {
    throw new Error(`${file}: "direnv" must be an absolute folder or start with ~`);
  }
  return folder;
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function ownHost(file: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "")
    throw new Error(`${file}: "host" must be this host's name`);
  return value;
}

function carddConfig(file: string, value: unknown): CarddConfig | undefined {
  if (value === undefined) return undefined;
  const { host = "local", root, db, restart } = isRecord(value) ? value : {};
  const command = strings(restart);
  if (
    typeof host !== "string" ||
    typeof root !== "string" ||
    typeof db !== "string" ||
    command.length === 0
  )
    throw new Error(`${file}: "cardd" needs "root", "db", "restart", and an optional "host"`);
  return { host, root, db, restart: command };
}

function count(file: string, key: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error(`${file}: "costs.${key}" must be a whole number of at least 0`);
  return value;
}

function costsConfig(file: string, value: unknown): Costs {
  if (value === undefined) return DEFAULT_COSTS;
  if (!isRecord(value)) throw new Error(`${file}: "costs" must be an object`);
  const { mateCacheRetention = DEFAULT_COSTS.mateCacheRetention } = value;
  if (mateCacheRetention !== "short" && mateCacheRetention !== "long")
    throw new Error(`${file}: "costs.mateCacheRetention" must be "short" or "long"`);
  return {
    mateCacheRetention,
    digestMinutes: count(
      file,
      "digestMinutes",
      value["digestMinutes"],
      DEFAULT_COSTS.digestMinutes,
    ),
    workerContextCap: count(
      file,
      "workerContextCap",
      value["workerContextCap"],
      DEFAULT_COSTS.workerContextCap,
    ),
  };
}

export function readLaneConfig(home: string): LaneConfig | undefined {
  const file = join(home, LANE_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const config: unknown = JSON.parse(text);
  if (!isRecord(config)) throw new Error(`${file} is not a JSON object`);
  const { lane, url, token } = config;
  if (typeof lane !== "string" || typeof url !== "string" || typeof token !== "string") {
    throw new Error(`${file} needs "lane", "url", and "token"`);
  }
  const folder = direnvFolder(file, config["direnv"]);
  const cardd = carddConfig(file, config["cardd"]);
  const own = ownHost(file, config["host"]);
  return {
    lane,
    url,
    token,
    ...(own === undefined ? {} : { host: own }),
    hosts: isRecord(config["hosts"]) ? config["hosts"] : {},
    roots: stringRecord(config["roots"]),
    args: strings(config["args"]),
    workerArgs: strings(config["workerArgs"]),
    ...(folder === undefined ? {} : { direnv: folder }),
    ...(cardd === undefined ? {} : { cardd }),
    costs: costsConfig(file, config["costs"]),
  };
}

const MATE_MODEL = "tier/orchestrator";
const MODEL_FLAGS = ["--model", "--provider"];

export function mateStartArgs(args: readonly string[]): string[] {
  const kept = args.filter(
    (arg, index) =>
      !MODEL_FLAGS.includes(arg) &&
      !MODEL_FLAGS.includes(args[index - 1] ?? "") &&
      !MODEL_FLAGS.some((flag) => arg.startsWith(`${flag}=`)),
  );
  return ["--model", MATE_MODEL, ...kept];
}

export function workerPiArgs(lane: LaneConfig): string[] {
  const own = lane.workerArgs;
  if (own.some((arg) => arg === "--model" || arg.startsWith("--model="))) return [...own];
  return [...globalModel(), ...own];
}

function globalModel(): string[] {
  const dir = process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(settings)) return [];
  const { defaultProvider: provider, defaultModel: model } = settings;
  if (typeof model !== "string") return [];
  return typeof provider === "string"
    ? ["--provider", provider, "--model", model]
    : ["--model", model];
}

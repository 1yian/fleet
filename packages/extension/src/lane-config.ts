// A lane's settings, in <home>/config/lane.json. The home is the fleet repo for main,
// and a git worktree of it for each second mate (docs/setup.md). The file is private
// (config/ is gitignored) because it holds the lane's cardd token.
//   { "lane": "cleo", "url": "ws://<cardd>/session", "token": "...",
//     "hosts": { "p620": ["ssh", "p620"] }, "roots": { "p620": "/home/me/.fleet/app" },
//     "args": ["--model", "tier/default"], "workerArgs": ["--model", "tier/quick"] }
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface LaneConfig {
  readonly lane: string;
  readonly url: string;
  readonly token: string;
  /** Hosts that this mate reaches over a transport such as ["ssh", "p620"]. Any other host runs here. */
  readonly hosts: Record<string, unknown>;
  /** Where each remote host keeps its checkout of this repository. Missing hosts use ~/.fleet/app. */
  readonly roots: Record<string, string>;
  /** Extra Pi arguments for the mate itself, such as a model. */
  readonly args: readonly string[];
  /** Extra Pi arguments for the mate's workers. */
  readonly workerArgs: readonly string[];
}

export const LANE_FILE = join("config", "lane.json");

type Json = Record<string, unknown>;
export const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each) => typeof each === "string") : [];

/** The lane's settings, or undefined when the folder is not a lane home. Throws for a file that is not valid. */
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
  const roots = isRecord(config["roots"]) ? config["roots"] : {};
  return {
    lane,
    url,
    token,
    hosts: isRecord(config["hosts"]) ? config["hosts"] : {},
    roots: Object.fromEntries(
      Object.entries(roots).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    args: strings(config["args"]),
    workerArgs: strings(config["workerArgs"]),
  };
}

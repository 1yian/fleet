import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { homeOf, provision, writeLaneConfig } from "./homes.ts";
import { isRecord, LANE_FILE, strings, type LaneConfig } from "./lane-config.ts";

const defaultFrom = (): string =>
  process.env["FLEET_CONFIG_DIR"] ?? join(homedir(), ".config", "fleet");
const agentDir = (): string =>
  process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
const sessionsDir = (): string =>
  process.env["PI_CODING_AGENT_SESSION_DIR"] ?? join(agentDir(), "sessions");

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const sessionFolder = (cwd: string): string =>
  join(
    sessionsDir(),
    `--${real(cwd)
      .replace(/^[/\\]/, "")
      .replaceAll(/[/\\:]/g, "-")}--`,
  );

function copySessions(from: string, to: string): number {
  const source = sessionFolder(from);
  if (!existsSync(source)) return 0;
  const target = sessionFolder(to);
  mkdirSync(target, { recursive: true });
  let copied = 0;
  for (const name of readdirSync(source).filter((file) => file.endsWith(".jsonl"))) {
    if (existsSync(join(target, name))) continue;
    const lines = readFileSync(join(source, name), "utf8").split("\n");
    const header: unknown = JSON.parse(lines[0] ?? "null");
    if (!isRecord(header) || header["type"] !== "session") continue;
    lines[0] = JSON.stringify({ ...header, cwd: real(to) });
    writeFileSync(join(target, name), lines.join("\n"));
    copied += 1;
  }
  return copied;
}

function readLegacy(file: string, lane: string): { config: LaneConfig; home: string } {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(value)) throw new Error(`${file} is not a JSON object`);
  const { url, token, home } = value;
  if (typeof url !== "string" || typeof token !== "string" || typeof home !== "string") {
    throw new Error(`${file} needs "url", "token", and "home"`);
  }
  const hosts = isRecord(value["hosts"]) ? value["hosts"] : {};
  const config = {
    lane,
    url,
    token,
    hosts,
    roots: {},
    args: strings(value["args"]),
    workerArgs: strings(value["workerArgs"]),
  };
  return { config, home };
}

function copyMissing(from: string, to: string): void {
  if (existsSync(from) && !existsSync(to)) cpSync(from, to, { recursive: true });
}

function migrateLane(root: string, from: string, file: string): string {
  const lane = file.slice(0, -".json".length);
  const { config, home: old } = readLegacy(join(from, file), lane);
  const home = lane === "main" ? root : homeOf(root, lane);
  if (existsSync(join(home, LANE_FILE))) throw new Error(`${home} already has a ${LANE_FILE}`);
  if (lane !== "main" && !existsSync(home)) provision(root, config);
  else writeLaneConfig(home, config);
  mkdirSync(join(home, "data"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  copyMissing(join(old, "AGENTS.md"), join(home, "data", "charter.md"));
  const settings = join(old, "config");
  const entries = existsSync(settings) ? readdirSync(settings) : [];
  for (const entry of entries) copyMissing(join(settings, entry), join(home, "config", entry));
  const sessions = copySessions(old, home);
  renameSync(join(from, file), join(from, `${file}.migrated`));
  return `${lane}: home ${home}, ${String(sessions)} conversations copied from ${old}`;
}

export function migrate(root: string, from: string = defaultFrom()): string[] {
  const files = existsSync(from)
    ? readdirSync(from)
        .filter((file) => file.endsWith(".json"))
        .sort()
    : [];
  const out = files.map((file) => migrateLane(root, from, file));
  return out.length === 0 ? [`nothing to migrate in ${from}`] : out;
}

export function undoMigration(root: string, from: string = defaultFrom()): string[] {
  const out: string[] = [];
  const files = existsSync(from)
    ? readdirSync(from)
        .filter((file) => file.endsWith(".json.migrated"))
        .sort()
    : [];
  for (const file of files) {
    const original = file.slice(0, -".migrated".length);
    const lane = original.slice(0, -".json".length);
    const home = lane === "main" ? root : homeOf(root, lane);
    if (existsSync(join(home, LANE_FILE)))
      renameSync(join(home, LANE_FILE), join(home, `${LANE_FILE}.undone`));
    renameSync(join(from, file), join(from, original));
    out.push(`${lane}: settings restored to ${join(from, original)}`);
  }
  if (out.length === 0) out.push(`nothing to undo in ${from}`);
  return out;
}

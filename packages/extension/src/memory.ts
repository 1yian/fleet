import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "./lane-config.ts";

export interface MemoryOptions {
  readonly seed?: string;
  readonly compactor?: string;
  readonly thinking?: string;
}

const MEMORY_HOME = join("data", "optchat");
const PROFILE_FILES = ["AGENTS.md", "config.json"] as const;
type ProfileFile = (typeof PROFILE_FILES)[number];
const SOCKET_PATH_LIMIT = process.platform === "darwin" ? 103 : 107;

function makeProfile(home: string, lane: string, options: MemoryOptions): string {
  const profile = join(home, MEMORY_HOME, "profiles", lane);
  const socket = join(realpathSync(home), MEMORY_HOME, "profiles", lane, "lock.sock");
  if (Buffer.byteLength(socket) > SOCKET_PATH_LIMIT) {
    throw new Error(
      `the profile's socket path is longer than ${String(SOCKET_PATH_LIMIT)} bytes: ${socket}`,
    );
  }
  const missing = PROFILE_FILES.filter((file) => !existsSync(join(profile, file)));
  if (missing.length === 0) return `profile: ${lane} is there already`;
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const defaults = defaultProfile(lane, options);
  for (const file of missing) {
    if (options.seed === undefined) {
      writeFileSync(join(profile, file), defaults[file], { mode: 0o600 });
    } else {
      copyFileSync(join(options.seed, file), join(profile, file));
    }
  }
  const source = options.seed === undefined ? "" : ` from ${options.seed}`;
  if (missing.length < PROFILE_FILES.length)
    return `profile: ${lane}, added ${missing.join(" and ")}${source}`;
  return `profile: ${lane}, ${options.seed === undefined ? "new" : `from ${options.seed}`}`;
}

function defaultProfile(lane: string, options: MemoryOptions): Record<ProfileFile, string> {
  const [provider = "tier", model = "compact"] = options.compactor?.split("/") ?? [];
  const choice = { provider, model, thinking: options.thinking ?? "low" };
  const settings = { compactor: choice, subagent: { ...choice, thinking: "off" } };
  return {
    "config.json": `${JSON.stringify(settings, null, 2)}\n`,
    "AGENTS.md": `# ${lane}\n\nThe ${lane} mate's conversation recall. The fleet's role contract, the lane's charter, and the cards remain authoritative.\n`,
  };
}

function writeSettings(home: string, lane: string, options: MemoryOptions): string {
  const file = join(home, "config", "optchat.json");
  if (existsSync(file)) {
    const found: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(found)) throw new Error(`${file} is not a JSON object`);
    if (found["enabled"] !== false) return "settings: config/optchat.json is there already";
    writeFileSync(file, `${JSON.stringify({ ...found, enabled: true }, null, 2)}\n`, {
      mode: 0o600,
    });
    return "settings: turned memory on in config/optchat.json";
  }
  const [provider, model] = options.compactor?.split("/") ?? [];
  const settings = {
    enabled: true,
    memoryHome: MEMORY_HOME,
    profile: lane,
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    ...(model === undefined ? {} : { compactorModel: model }),
    ...(provider === undefined || model === undefined ? {} : { compactorProvider: provider }),
  };
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return "settings: wrote config/optchat.json";
}

export function setUpMemory(home: string, lane: string, options: MemoryOptions): string[] {
  if (options.compactor !== undefined && !/^[^/]+\/[^/]+$/.test(options.compactor)) {
    throw new Error("--compactor is provider/model, such as tier/compact");
  }
  return [makeProfile(home, lane, options), writeSettings(home, lane, options)];
}

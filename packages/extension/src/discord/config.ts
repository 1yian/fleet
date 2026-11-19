import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const DISCORD_URL = "https://discord.com/api/v10";
const GROQ_URL = "https://api.groq.com/openai/v1";
const GROQ_MODEL = "whisper-large-v3-turbo";
const WHISPER_MODEL_FILE = "ggml-large-v3-turbo.bin";
const OPEN_SUPER_WHISPER_MODELS = [
  "Library",
  "Application Support",
  "ru.starmel.OpenSuperWhisper",
  "whisper-models",
];
const SNOWFLAKE = /^\d{15,25}$/;
const ASSIGNMENT = /^(?:export\s+)?(BRIDGE_[A-Z0-9_]+)\s*=\s*(.*)$/;
const QUOTED = /^(["'])(.*)\1$/;
const REQUIRED = ["BRIDGE_BOT_TOKEN", "BRIDGE_CHANNEL_ID", "BRIDGE_ALLOWED_USER_IDS"] as const;

export interface GroqSpeech {
  readonly engine: "groq";
  readonly key: string;
  readonly model: string;
  readonly url: string;
}

export interface LocalSpeech {
  readonly engine: "local";
  readonly whisper: string;
  readonly ffmpeg: string;
  readonly model: string;
  readonly language: string;
}

export type SpeechConfig = GroqSpeech | LocalSpeech;

export interface BridgeConfig {
  readonly token: string;
  readonly channel: string;
  readonly guild: string | undefined;
  readonly allowed: ReadonlySet<string>;
  readonly discordUrl: string;
  readonly speech: SpeechConfig;
}

export type BridgeSettings =
  | { readonly state: "off" }
  | { readonly state: "refused"; readonly why: string }
  | { readonly state: "on"; readonly config: BridgeConfig };

type Values = Readonly<Record<string, string>>;

function readIfPresent(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw new Error(`${file} cannot be read`, { cause: error });
  }
}

function assignment(line: string): [string, string] | undefined {
  const found = ASSIGNMENT.exec(line.trim());
  const name = found?.[1];
  const raw = found?.[2]?.trim();
  if (name === undefined || raw === undefined) return undefined;
  const value = QUOTED.exec(raw)?.[2] ?? raw;
  return value === "" ? undefined : [name, value];
}

function fileValues(file: string): Values {
  const pairs = readIfPresent(file)
    .split("\n")
    .flatMap((line) => {
      const pair = assignment(line);
      return pair === undefined ? [] : [pair];
    });
  return Object.fromEntries(pairs);
}

function environmentValues(): Values {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("BRIDGE_") && value !== undefined && value.trim() !== "")
      values[name] = value.trim();
  }
  return values;
}

function bridgeValues(home: string): Values {
  return {
    ...fileValues(join(home, ".env")),
    ...fileValues(join(home, "config", "bridge.env")),
    ...environmentValues(),
  };
}

function snowflake(name: string, text: string): string {
  if (!SNOWFLAKE.test(text)) throw new Error(`${name} must hold Discord IDs: digits only`);
  return text;
}

function allowedUsers(text: string): ReadonlySet<string> {
  const ids = text
    .split(/[\s,]+/)
    .filter((id) => id !== "")
    .map((id) => snowflake("BRIDGE_ALLOWED_USER_IDS", id));
  if (ids.length === 0) throw new Error("BRIDGE_ALLOWED_USER_IDS lists no user");
  return new Set(ids);
}

function baseUrl(name: string, value: string | undefined, fallback: string): string {
  const url = value ?? fallback;
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error(`${name} must be an http or https URL`);
  return url.replace(/\/+$/, "");
}

function modelPath(value: string | undefined): string {
  if (value === undefined) return join(homedir(), ...OPEN_SUPER_WHISPER_MODELS, WHISPER_MODEL_FILE);
  const path = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(path)) throw new Error("BRIDGE_WHISPER_MODEL must be an absolute path");
  return path;
}

function localSpeech(values: Values): LocalSpeech {
  return {
    engine: "local",
    whisper: values["BRIDGE_WHISPER_CLI"] ?? "whisper-cli",
    ffmpeg: values["BRIDGE_FFMPEG"] ?? "ffmpeg",
    model: modelPath(values["BRIDGE_WHISPER_MODEL"]),
    language: values["BRIDGE_WHISPER_LANGUAGE"] ?? "auto",
  };
}

function groqSpeech(values: Values): GroqSpeech {
  const key = values["BRIDGE_GROQ_API_KEY"];
  if (key === undefined) throw new Error("BRIDGE_GROQ_API_KEY must be set when BRIDGE_STT is groq");
  return {
    engine: "groq",
    key,
    model: values["BRIDGE_GROQ_MODEL"] ?? GROQ_MODEL,
    url: baseUrl("BRIDGE_GROQ_API_URL", values["BRIDGE_GROQ_API_URL"], GROQ_URL),
  };
}

function speechConfig(values: Values): SpeechConfig {
  const engine = values["BRIDGE_STT"] ?? "local";
  if (engine === "local") return localSpeech(values);
  if (engine === "groq") return groqSpeech(values);
  throw new Error("BRIDGE_STT must be local or groq");
}

function settingsOf(values: Values): BridgeSettings {
  const token = values["BRIDGE_BOT_TOKEN"];
  const channel = values["BRIDGE_CHANNEL_ID"];
  const users = values["BRIDGE_ALLOWED_USER_IDS"];
  if (token === undefined || channel === undefined || users === undefined) {
    const missing = REQUIRED.filter((name) => values[name] === undefined);
    if (missing.length === REQUIRED.length) return { state: "off" };
    return { state: "refused", why: `${missing.join(", ")} must be set` };
  }
  const guild = values["BRIDGE_GUILD_ID"];
  return {
    state: "on",
    config: {
      token,
      channel: snowflake("BRIDGE_CHANNEL_ID", channel),
      guild: guild === undefined ? undefined : snowflake("BRIDGE_GUILD_ID", guild),
      allowed: allowedUsers(users),
      discordUrl: baseUrl("BRIDGE_DISCORD_API_URL", values["BRIDGE_DISCORD_API_URL"], DISCORD_URL),
      speech: speechConfig(values),
    },
  };
}

export function readBridgeSettings(home: string): BridgeSettings {
  try {
    return settingsOf(bridgeValues(home));
  } catch (error) {
    return { state: "refused", why: error instanceof Error ? error.message : String(error) };
  }
}

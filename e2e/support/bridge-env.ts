import { fileURLToPath } from "node:url";
import type { FakeDiscord } from "./fake-discord.ts";
import type { Turn } from "./harness.ts";

export const EXTENSION = fileURLToPath(
  new URL("../../packages/extension/src/index.ts", import.meta.url),
);
export const CAPTAIN = "1300000000000000001";
export const ONLINE = "fleet bridge online.";

const BRIDGE_KEYS = [
  "BRIDGE_BOT_TOKEN",
  "BRIDGE_CHANNEL_ID",
  "BRIDGE_ALLOWED_USER_IDS",
  "BRIDGE_GUILD_ID",
  "BRIDGE_DISCORD_API_URL",
  "BRIDGE_STT",
  "BRIDGE_WHISPER_CLI",
  "BRIDGE_WHISPER_MODEL",
  "BRIDGE_WHISPER_LANGUAGE",
  "BRIDGE_FFMPEG",
  "BRIDGE_GROQ_API_KEY",
  "BRIDGE_GROQ_MODEL",
  "BRIDGE_GROQ_API_URL",
];

export const noBridge = (): Record<string, string> =>
  Object.fromEntries(BRIDGE_KEYS.map((key) => [key, ""]));

export const bridgeSettings = (
  discord: FakeDiscord,
  more: Record<string, string> = {},
): Record<string, string> => ({
  ...noBridge(),
  BRIDGE_BOT_TOKEN: discord.token,
  BRIDGE_CHANNEL_ID: discord.channel,
  BRIDGE_ALLOWED_USER_IDS: CAPTAIN,
  BRIDGE_DISCORD_API_URL: discord.apiUrl,
  ...more,
});

export const userTexts = (turns: readonly Turn[]): string[] =>
  turns.filter((turn) => turn.role === "user").map((turn) => turn.text);

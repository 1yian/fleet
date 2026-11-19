import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isRecord } from "../lane-config.ts";
import type { GroqConfig } from "./config.ts";
import type { Discord } from "./discord.ts";

const VOICE_MESSAGE_FLAG = 8192;
const TRANSCRIBE_MS = 120_000;
const FILE_NAME_MAX = 100;
const SNOWFLAKE = /^\d+$/;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const VIDEO = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;
const AUDIO = /\.(ogg|oga|mp3|m4a|wav|flac|opus)$/i;

interface Attachment {
  readonly url: string;
  readonly name: string;
  readonly voice: boolean;
}

export interface Inbound {
  readonly id: string;
  readonly author: string | undefined;
  readonly text: string;
  readonly attachments: readonly Attachment[];
}

export interface Media {
  readonly discord: Discord;
  readonly directory: string;
  readonly groq: GroqConfig | undefined;
}

function attachmentsOf(value: unknown, voiceMessage: boolean): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((item) => {
    const { url, filename, waveform } = item;
    if (typeof url !== "string" || url === "") return [];
    const name = typeof filename === "string" && filename !== "" ? filename : "file";
    return [{ url, name, voice: voiceMessage || typeof waveform === "string" }];
  });
}

function textOf(message: Record<string, unknown>): string {
  const { content } = message;
  return typeof content === "string" ? content.trim() : "";
}

function forwarded(message: Record<string, unknown>): Record<string, unknown>[] {
  const snapshots = message["message_snapshots"];
  if (!Array.isArray(snapshots)) return [];
  return snapshots.filter(isRecord).flatMap((snapshot) => {
    const inner = snapshot["message"];
    return isRecord(inner) ? [inner] : [];
  });
}

export function parseMessage(value: unknown): Inbound | undefined {
  if (!isRecord(value)) return undefined;
  const { id, author, flags } = value;
  if (typeof id !== "string" || !SNOWFLAKE.test(id)) return undefined;
  const voiceMessage = typeof flags === "number" && (flags & VOICE_MESSAGE_FLAG) !== 0;
  const parts = [value, ...forwarded(value)];
  return {
    id,
    author: isRecord(author) && typeof author["id"] === "string" ? author["id"] : undefined,
    text: parts
      .map(textOf)
      .filter((text) => text !== "")
      .join("\n"),
    attachments: parts.flatMap((part) => attachmentsOf(part["attachments"], voiceMessage)),
  };
}

async function save(attachment: Attachment, media: Media): Promise<string | undefined> {
  const bytes = await media.discord.download(attachment.url);
  if (bytes === undefined) return undefined;
  const safe = basename(attachment.name)
    .replace(/[^\w.-]/g, "_")
    .slice(-FILE_NAME_MAX);
  const destination = join(
    media.directory,
    `${String(Date.now())}-${randomBytes(2).toString("hex")}-${safe}`,
  );
  try {
    mkdirSync(media.directory, { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { mode: 0o600 });
    return destination;
  } catch {
    return undefined;
  }
}

async function transcribe(groq: GroqConfig, file: string): Promise<string | undefined> {
  try {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(file)]), basename(file));
    form.append("model", groq.model);
    form.append("response_format", "text");
    const response = await fetch(`${groq.url}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${groq.key}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_MS),
    });
    if (!response.ok) return undefined;
    const text = (await response.text()).trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

function labelOf(attachment: Attachment): string {
  if (attachment.voice || AUDIO.test(attachment.name)) return "audio attachment";
  if (IMAGE.test(attachment.name)) return "image";
  return VIDEO.test(attachment.name) ? "video" : "file";
}

export async function render(message: Inbound, media: Media): Promise<string> {
  const spoken: string[] = [];
  const references: string[] = [];
  for (const attachment of message.attachments) {
    const file = await save(attachment, media);
    if (file === undefined) continue;
    const label = labelOf(attachment);
    if (label !== "audio attachment") {
      references.push(`[${label}: ${file}]`);
      continue;
    }
    const transcript = media.groq === undefined ? undefined : await transcribe(media.groq, file);
    if (transcript === undefined) references.push(`[${label}: ${file} (transcription failed)]`);
    else spoken.push(transcript);
  }
  return [message.text, ...spoken, ...references]
    .filter((part) => part !== "")
    .join("\n")
    .trim();
}

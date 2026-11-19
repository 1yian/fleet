import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { isRecord } from "../lane-config.ts";

const REPLY_MAX = 1900;
const UPLOADABLE =
  /\.(png|jpe?g|gif|webp|bmp|svg|mp4|mov|webm|mkv|avi|m4v|ogg|oga|mp3|m4a|wav|flac|opus|pdf|txt|csv|json|md|zip)$/i;
const PRIVATE_FOLDERS = ["config", "data", "state"];
const MEDIA_LINE = /^\s*MEDIA:\s*(\/\S+)\s*$/;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\((\/[^)\s]+)\)/g;
const BACKTICK_PATH = /`(\/[^`\s]+)`/g;

const slices = (line: string, max: number): string[] =>
  Array.from({ length: Math.ceil(line.length / max) }, (_, index) =>
    line.slice(index * max, (index + 1) * max),
  );

export function chunk(text: string, max = REPLY_MAX): string[] {
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const joined = current === "" ? line : `${current}\n${line}`;
    if (joined.length <= max) {
      current = joined;
      continue;
    }
    if (current !== "") parts.push(current);
    const pieces = slices(line, max);
    current = pieces.pop() ?? "";
    parts.push(...pieces);
  }
  if (current !== "") parts.push(current);
  return parts;
}

const isDotenv = (path: string): boolean => basename(path).endsWith(".env");

function realOr(path: string, fallback: string): string {
  try {
    return realpathSync(path);
  } catch {
    return fallback;
  }
}

function isInside(folder: string, path: string): boolean {
  const between = relative(folder, path);
  return between !== ".." && !between.startsWith(`..${sep}`) && !isAbsolute(between);
}

function isPrivate(real: string, home: string): boolean {
  const realHome = realOr(home, home);
  return PRIVATE_FOLDERS.some((name) => {
    const folder = join(realHome, name);
    return isInside(realOr(folder, folder), real);
  });
}

function isUploadable(candidate: string, home: string): boolean {
  if (!candidate.startsWith("/") || !UPLOADABLE.test(candidate) || isDotenv(candidate)) {
    return false;
  }
  try {
    if (!statSync(candidate).isFile()) return false;
    const real = realpathSync(candidate);
    return !isDotenv(real) && !isPrivate(real, home);
  } catch {
    return false;
  }
}

export function extractMedia(text: string, home: string): { clean: string; paths: string[] } {
  const paths = new Set<string>();
  const take = (candidate: string): boolean => {
    if (paths.has(candidate)) return true;
    if (!isUploadable(candidate, home)) return false;
    paths.add(candidate);
    return true;
  };
  const withoutTokens = (line: string): string =>
    line
      .replace(MARKDOWN_IMAGE, (whole, path: string) => (take(path) ? "" : whole))
      .replace(BACKTICK_PATH, (whole, path: string) => (take(path) ? "" : whole));
  const lines = text.split("\n").flatMap((line) => {
    const named = MEDIA_LINE.exec(line)?.[1];
    return named !== undefined && take(named) ? [] : [withoutTokens(line)];
  });
  const clean = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { clean, paths: [...paths] };
}

export function assistantText(message: unknown): string {
  if (!isRecord(message) || message["role"] !== "assistant") return "";
  const content = message["content"];
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .flatMap((block) =>
      block["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : [],
    )
    .join("\n")
    .trim();
}

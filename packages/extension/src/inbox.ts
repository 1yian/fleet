// Fleet entries in the Pi session: how they read to the model, and which ones
// the session file already holds (spec sections 9.4 and 9.5).
import { existsSync, readFileSync } from "node:fs";
import type { Entry } from "@fleet/protocol";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The entry ID of a fleet custom message or session entry. */
export function fleetEntryId(message: unknown): number | undefined {
  if (!isRecord(message) || message["customType"] !== "fleet") return undefined;
  const details = message["details"];
  const id = isRecord(details) ? details["entryId"] : undefined;
  return typeof id === "number" ? id : undefined;
}

/** Pi skips lines that do not parse, such as a line torn by a crash. So do we. */
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** The fleet entry IDs in the session file on disk. Pi creates the file late, so it may not exist. */
export function idsInSessionFile(file: string | undefined): number[] {
  if (file === undefined || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parseLine)
    .filter((entry) => isRecord(entry) && entry["type"] === "custom_message")
    .map(fleetEntryId)
    .filter((id) => id !== undefined);
}

const field = (entry: Entry, key: string): string | undefined => {
  const value = entry.fields[key];
  return typeof value === "string" ? value : undefined;
};

/** The text the model reads. It starts with [fleet] so agents can tell it from the captain. */
export function format(entry: Entry): string {
  const card = `c-${String(entry.card)}`;
  if (entry.kind === "report") {
    const key = field(entry, "key");
    const re = field(entry, "re");
    return [
      `[fleet] ${card} ${field(entry, "status") ?? "report"}${key === undefined ? "" : ` [${key}]`}: ${entry.body}`,
      re === undefined ? "" : ` (re your comment: ${re})`,
    ].join("");
  }
  if (entry.kind === "job-result") {
    const job = `job ${String(entry.fields["job"])} (${field(entry, "label") ?? "job"})`;
    if (entry.fields["lost"] === true) return `[fleet] ${card} ${job} lost: ${entry.body}`;
    return `[fleet] ${card} ${job} exited ${String(entry.fields["exitCode"])}: ${entry.body}`;
  }
  const who = entry.author.replace(/^mate:/, "");
  const resolves = field(entry, "resolves");
  const note = resolves === undefined ? "" : ` (answers ${resolves})`;
  return `[fleet] ${who} on ${card}${entry.kind === "comment" ? "" : ` (${entry.kind})`}: ${entry.body}${note}`;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** A time from the model: ISO 8601 with Z or an explicit offset, so no host's local zone can shift it. */
export function parseUtc(text: string): number {
  const ms = ISO_UTC.test(text) ? Date.parse(text) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new Error(
      `use an ISO 8601 time ending in Z or a +hh:mm/-hh:mm offset, like 2026-05-01T10:00:00Z: ${text}`,
    );
  }
  return ms;
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Whether a user-role message in the session file holds these words (spec section 9.6). */
export function captainSaid(file: string | undefined, words: string): boolean {
  if (file === undefined || !existsSync(file) || squash(words) === "") return false;
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line): unknown[] => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .some((entry) => {
      const message = isRecord(entry) && entry["type"] === "message" ? entry["message"] : undefined;
      return (
        isRecord(message) &&
        message["role"] === "user" &&
        squash(textOf(message)).includes(squash(words))
      );
    });
}

/** The text of a Pi message: its string content, or its text blocks joined. */
export function textOf(message: unknown): string {
  if (typeof message !== "object" || message === null || !("content" in message)) return "";
  const content: unknown = message.content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");
}

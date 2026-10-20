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
  const who = entry.author.replace(/^mate:/, "");
  const resolves = field(entry, "resolves");
  const note = resolves === undefined ? "" : ` (answers ${resolves})`;
  return `[fleet] ${who} on ${card}${entry.kind === "comment" ? "" : ` (${entry.kind})`}: ${entry.body}${note}`;
}

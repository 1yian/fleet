import { existsSync, readFileSync } from "node:fs";
import { CAPTAIN, howToAnswerWake, howToReply, type Entry } from "@fleet/protocol";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function fleetEntryId(message: unknown): number | undefined {
  if (!isRecord(message) || message["customType"] !== "fleet") return undefined;
  const details = message["details"];
  const id = isRecord(details) ? details["entryId"] : undefined;
  return typeof id === "number" ? id : undefined;
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

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

const suffix = (entry: Entry, key: string, label: string): string => {
  const value = field(entry, key);
  return value === undefined ? "" : ` (${label}${value})`;
};

function prSuffix(entry: Entry): string {
  const url = field(entry, "pr");
  const state = field(entry, "prState");
  if (url === undefined) return suffix(entry, "prNote", "") + suffix(entry, "landing", "");
  return ` (PR ${url}${state === undefined || state === "OPEN" ? "" : `, ${state.toLowerCase()}`})`;
}

function replySuffix(entry: Entry): string {
  const to = field(entry, "for");
  if (field(entry, "owes") !== undefined && (to === "worker" || to === "mate")) {
    const id = `r-${String(entry.id)}`;
    const by = entry.author === CAPTAIN ? ` by ${field(entry, "owes") ?? ""}` : "";
    return ` (reply owed${by}, ${id}: ${howToReply(to, entry.card, id, entry.author)})`;
  }
  return `${suffix(entry, "replyTo", "replies ")}${suffix(entry, "withdraws", "withdraws ")}`;
}

function formatReport(entry: Entry, card: string): string {
  const status = field(entry, "status") ?? "report";
  const key = field(entry, "key");
  const after = field(entry, "statusAfter");
  const head = `[fleet] ${card} ${status}${key === undefined ? "" : ` [${key}]`}: ${entry.body}`;
  const now = after === undefined || after === status ? "" : ` (card now ${after})`;
  return `${head}${prSuffix(entry)}${now}${replySuffix(entry)}`;
}

function formatJob(entry: Entry, card: string): string {
  const job = `job ${String(entry.fields["job"])} (${field(entry, "label") ?? "job"})`;
  if (entry.fields["lost"] === true) return `[fleet] ${card} ${job} lost: ${entry.body}`;
  return `[fleet] ${card} ${job} exited ${String(entry.fields["exitCode"])}: ${entry.body}`;
}

function formatWake(entry: Entry): string {
  if (field(entry, "wake") === "script") return `[fleet] ${entry.body}`;
  const id = `r-${String(entry.id)}`;
  return `[fleet] ${entry.body} (reply owed, ${id}: ${howToAnswerWake(entry.card, id)})`;
}

const LABELS: Readonly<Record<string, string>> = { cleanup: "close", release: "hold cleared" };

const laneNote = (entry: Entry): string => {
  const lane = entry.author === "captain" ? field(entry, "lane") : undefined;
  return lane === undefined ? "" : ` (in ${lane}'s lane)`;
};

const AGAIN = " (sent again: the turn that got it ended before it was taken in)";

export function format(entry: Entry, name: string, again = false): string {
  return `${formatOnce(entry, name)}${again ? AGAIN : ""}`;
}

function formatOnce(entry: Entry, name: string): string {
  const card = name === "" ? `c-${String(entry.card)}` : `c-${String(entry.card)} ${name}`;
  if (entry.kind === "report") return formatReport(entry, card);
  if (entry.kind === "job-result") return formatJob(entry, card);
  if (entry.kind === "comment" && field(entry, "wake") !== undefined) return formatWake(entry);
  const who = entry.author.replace(/^mate:/, "");
  const kind =
    entry.kind === "comment" ? laneNote(entry) : ` (${LABELS[entry.kind] ?? entry.kind})`;
  const answers = suffix(entry, "resolves", "answers ");
  return `[fleet] ${who} on ${card}${kind}: ${entry.body}${answers}${replySuffix(entry)}`;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

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

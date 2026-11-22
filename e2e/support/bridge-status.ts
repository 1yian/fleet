import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, parseRecord } from "./json.ts";
import { poll, type Pi } from "./harness.ts";

export type StatusReader = (path: string) => unknown;

const statusFile = (home: string): string => join(home, "state", "discord-bridge", "status.json");

export const isStamp = (value: unknown): boolean =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

export const stampAt = (value: unknown): number => Date.parse(String(value));

function readerOf(text: string): StatusReader {
  const status = parseRecord(text);
  return (path) =>
    path
      .split(".")
      .reduce<unknown>((found, key) => (isRecord(found) ? found[key] : undefined), status);
}

export const statusText = (home: string): string | undefined =>
  existsSync(statusFile(home)) ? readFileSync(statusFile(home), "utf8") : undefined;

export async function waitForStatus(
  home: string,
  what: string,
  ready: (read: StatusReader) => boolean,
): Promise<StatusReader> {
  return poll(() => {
    const text = statusText(home);
    if (text === undefined) return undefined;
    const read = readerOf(text);
    return ready(read) ? read : undefined;
  }, what);
}

const isReport = (request: Record<string, unknown>): boolean =>
  request["method"] === "notify" && String(request["message"]).startsWith("discord bridge: ");

export async function askBridge(pi: Pi): Promise<string> {
  const before = pi.uiRequests.filter(isReport).length;
  pi.prompt("/bridge");
  const report = await poll(() => pi.uiRequests.filter(isReport).at(before), "the /bridge report");
  return String(report["message"]);
}

import { join } from "node:path";
import { HostUnread } from "./host.ts";
import { isAbsent, readRegular } from "./lane-config.ts";

export const CRASH_WINDOW_MS = 10 * 60_000;

export const stoppedFile = (home: string): string => join(home, "state", "stopped");
export const startsFile = (home: string): string => join(home, "state", "starts");

export type Lifecycle = readonly [string | undefined, string | undefined];

export function readState(file: string, name: string): string | undefined {
  try {
    return readRegular(file);
  } catch (error) {
    if (isAbsent(file, error)) return undefined;
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    throw new HostUnread(`could not read ${name} (${code})`);
  }
}

export const heldReasonOf = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : text.trim() || "stopped";

export const sampleLifecycle = (home: string): Lifecycle => [
  readState(stoppedFile(home), "state/stopped"),
  readState(startsFile(home), "state/starts"),
];

export function recentStartsOf(text: string | undefined, now: number): number[] {
  if (text === undefined) return [];
  const lines = text.split("\n");
  const complete = lines.pop() === "";
  if (!complete || lines.length === 0 || !lines.every((line) => /^[1-9]\d{0,15}$/.test(line)))
    throw new HostUnread("state/starts is incomplete");
  return lines.map(Number).filter((time) => time > now - CRASH_WINDOW_MS);
}

export function confirmLifecycle(info: { lane: string; home: string }, sample: Lifecycle): void {
  const now = sampleLifecycle(info.home);
  if (now.some((text, at) => text !== sample[at]))
    throw new HostUnread(`${info.lane} lifecycle state changed after it was checked`);
}

export function lifecycleMoved(
  info: { lane: string; home: string },
  sample: Lifecycle,
): string | undefined {
  try {
    confirmLifecycle(info, sample);
  } catch (error) {
    if (error instanceof HostUnread) return error.message;
    throw error;
  }
  return undefined;
}

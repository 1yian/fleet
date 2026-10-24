import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Link } from "./link.ts";

const git = promisify(execFile);
const STREAM_GAP_MS = 5_000;

async function workState(): Promise<string | undefined> {
  try {
    const [head, files] = await Promise.all([
      git("git", ["rev-parse", "HEAD"]),
      git("git", ["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z"]),
    ]);
    const stamps = await Promise.all(
      files.stdout
        .split("\0")
        .filter(Boolean)
        .map(async (path) => {
          const stamp = await lstat(path).then(
            (stat) => `${String(stat.mtimeMs)}:${String(stat.size)}`,
            () => "missing",
          );
          return `${path}:${stamp}`;
        }),
    );
    return `${head.stdout}\0${stamps.join("\0")}`;
  } catch {
    return undefined;
  }
}

function progressSince(): () => Promise<boolean> {
  let previous = workState();
  return async () => {
    const before = await previous;
    previous = workState();
    const after = await previous;
    return before !== undefined && after !== undefined && before !== after;
  };
}

function streamGate(now: () => number = Date.now): () => boolean {
  let last = 0;
  return () => {
    const at = now();
    if (at - last < STREAM_GAP_MS) return false;
    last = at;
    return true;
  };
}

export function reportActivity(
  pi: ExtensionAPI,
  link: Link,
  settled: () => "waiting" | "idle",
): void {
  const progressed = progressSince();
  const streaming = streamGate();
  let inRun = false;
  const active = (): void => {
    link.activity("running");
  };
  pi.on("agent_start", () => {
    inRun = true;
    active();
  });
  pi.events.on("fleet:connected", () => {
    if (inRun) active();
  });
  pi.on("tool_execution_start", active);
  pi.on("tool_execution_update", () => {
    if (streaming()) active();
  });
  pi.on("message_update", () => {
    if (streaming()) active();
  });
  pi.on("tool_execution_end", async () => {
    link.activity("running", await progressed());
  });
  pi.on("agent_settled", () => {
    inRun = false;
    link.activity(settled());
  });
}

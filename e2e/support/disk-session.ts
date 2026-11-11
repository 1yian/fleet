import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { HerdrLab } from "./herdr.ts";
import { records } from "./json.ts";

const WAIT_MS = 60_000;

export async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function crossingOf(line: string): { key: string; said: boolean } | undefined {
  const [entry] = records([JSON.parse(line)]);
  const [details] = records([entry?.["details"] ?? entry?.["data"]]);
  const key = details?.["crossing"];
  if (typeof key !== "string" || !key.startsWith("far|")) return undefined;
  return { key, said: entry?.["customType"] === "fleet-disk" };
}

export function replayed(file: string): string[] {
  const held = new Set<string>();
  const lines = readFileSync(file, "utf8").split("\n");
  for (const found of lines.filter((line) => line.includes("fleet-disk")).map(crossingOf)) {
    if (found?.said === true) held.add(found.key);
    else if (found !== undefined) held.delete(found.key);
  }
  return [...held];
}

export async function stopMain(lab: HerdrLab, pane: string): Promise<void> {
  const before = records([
    (await lab.run(["pane", "process-info", "--pane", pane]))["process_info"],
  ]);
  const group = Number(before[0]?.["foreground_process_group_id"]);
  const shell = Number(before[0]?.["shell_pid"]);
  process.kill(-group, "SIGKILL");
  const deadline = Date.now() + 30_000;
  for (;;) {
    const info = records([
      (await lab.run(["pane", "process-info", "--pane", pane]))["process_info"],
    ]);
    if (Number(info[0]?.["foreground_process_group_id"]) === shell) break;
    assert.ok(Date.now() < deadline, "the mate's pane did not return to its shell");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { groupIdentity, signalOwnedGroup, sweepGroups } from "./marked.ts";

const watched = new Map<number, string>();
const hooks = new Map<string, string[]>();
const scopes = new Set<string>();
const roots = new Set<string>();

function descendantsOf(root: number): number[] {
  const table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [pid = 0, parent = 0] = line.trim().split(/\s+/).map(Number);
    if (pid > 0) children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const found: number[] = [];
  for (let queue = [root]; queue.length > 0;) {
    queue = queue.flatMap((pid) => children.get(pid) ?? []);
    found.push(...queue);
  }
  return found;
}

function signal(pid: number, name: "SIGSTOP" | "SIGKILL"): void {
  try {
    process.kill(pid, name);
  } catch {
    return;
  }
}

function sweep(root: number, identity: string): void {
  const frozen = new Set<number>();
  for (;;) {
    const fresh = [root, ...descendantsOf(root)].filter((pid) => !frozen.has(pid));
    if (fresh.length === 0) break;
    for (const pid of fresh) {
      frozen.add(pid);
      signal(pid, "SIGSTOP");
    }
  }
  signalOwnedGroup(root, identity, "SIGKILL");
  for (const pid of frozen) signal(pid, "SIGKILL");
}

function pathOf(line: string, verb: string): string {
  const parsed: unknown = JSON.parse(line.slice(verb.length + 1));
  if (typeof parsed !== "string") throw new Error("reaper path must be a string");
  return parsed;
}

function argvOf(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const [verb = "", text = ""] = line.split(" ", 2);
  const pid = Number(text);
  if (verb === "watch") watched.set(pid, line.slice(verb.length + text.length + 2));
  else if (verb === "release") watched.delete(pid);
  else if (verb === "hook") hooks.set(text, argvOf(line.slice(verb.length + text.length + 2)));
  else if (verb === "unhook") hooks.delete(text);
  else if (verb === "scope") scopes.add(pathOf(line, verb));
  else if (verb === "root") roots.add(pathOf(line, verb));
});
async function teardown(): Promise<void> {
  for (const [file = "", ...args] of hooks.values()) {
    try {
      execFileSync(file, args, { stdio: "ignore", timeout: 20_000 });
    } catch {
      continue;
    }
  }
  for (const [pid, began] of watched) {
    if (began !== "" && groupIdentity(pid) === began) sweep(pid, began);
  }
  let proved = true;
  for (const scope of scopes) {
    try {
      const { unresolved } = await sweepGroups(scope, 0);
      if (unresolved.length > 0) proved = false;
    } catch {
      proved = false;
    }
  }
  for (const root of roots) {
    if (proved && !existsSync(join(root, "unresolved-groups"))) {
      rmSync(root, { recursive: true, force: true });
    } else {
      process.stderr.write(`unresolved process ownership; kept ${root}\n`);
    }
  }
}

lines.on("close", () => {
  void teardown();
});

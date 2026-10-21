import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const watched = new Map<number, string>();
const hooks = new Map<string, string[]>();

function startOf(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

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

function sweep(root: number): void {
  const frozen = new Set<number>();
  for (;;) {
    const fresh = [root, ...descendantsOf(root)].filter((pid) => !frozen.has(pid));
    if (fresh.length === 0) break;
    for (const pid of fresh) {
      frozen.add(pid);
      signal(pid, "SIGSTOP");
    }
  }
  signal(-root, "SIGKILL");
  for (const pid of frozen) signal(pid, "SIGKILL");
}

function argvOf(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const [verb = "", text = ""] = line.split(" ", 2);
  const pid = Number(text);
  if (verb === "watch") watched.set(pid, startOf(pid));
  else if (verb === "release") watched.delete(pid);
  else if (verb === "hook") hooks.set(text, argvOf(line.slice(verb.length + text.length + 2)));
  else if (verb === "unhook") hooks.delete(text);
});
lines.on("close", () => {
  for (const [file = "", ...args] of hooks.values()) {
    try {
      execFileSync(file, args, { stdio: "ignore", timeout: 20_000 });
    } catch {
      continue;
    }
  }
  for (const [pid, began] of watched) {
    if (began !== "" && startOf(pid) === began) sweep(pid);
  }
});

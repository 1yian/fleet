import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./run-root.ts";

const STUBS = fileURLToPath(new URL("./stubs", import.meta.url));
const PROBES = join(STUBS, "probes");
const PREREQUISITES = ["node", "git", "gh", "herdr", "zstd", "lavish-axi", "no-mistakes", "direnv"];

const SHELL = ["sh", "env", "dirname", "realpath"];

const SYSTEM_TOOLS = [
  ...SHELL,
  "uname",
  "id",
  "ps",
  "awk",
  "tr",
  "cut",
  "cat",
  "mkdir",
  "mktemp",
  "rm",
  "mv",
  "cp",
  "tar",
  "wc",
  "sed",
  "head",
  "tail",
  "ls",
  "basename",
  "sleep",
  "cksum",
  "git",
  "kill",
  "grep",
  "sort",
];
const HOMEBREW_TOOLS = ["herdr", "zstd"];

process.env["PATH"] = [PROBES, process.env["PATH"] ?? "", STUBS].join(delimiter);

function found(tool: string): string {
  const path = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
  if (!existsSync(path)) throw new Error(`${tool} is not on the PATH of this test run`);
  return path;
}

export function pathWithout(...missing: readonly string[]): string {
  const dir = tempDir("fleet-tools-");
  for (const tool of [...PREREQUISITES.filter((each) => !missing.includes(each)), ...SHELL])
    symlinkSync(found(tool), join(dir, tool));
  return dir;
}

function linkTools(dir: string, tools: readonly string[]): void {
  for (const tool of tools) {
    const path = execFileSync("sh", ["-c", `command -v ${tool} || true`], {
      encoding: "utf8",
    }).trim();
    if (existsSync(path)) symlinkSync(path, join(dir, tool));
  }
}

export function launchdLikeHost(): { system: string; homebrew: string } {
  const system = tempDir("fleet-launchd-bin-");
  const homebrew = tempDir("fleet-homebrew-bin-");
  linkTools(system, SYSTEM_TOOLS);
  linkTools(homebrew, HOMEBREW_TOOLS);
  return { system, homebrew };
}

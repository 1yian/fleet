import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const STUBS = fileURLToPath(new URL("./stubs", import.meta.url));
const PROBES = join(STUBS, "probes");
const PREREQUISITES = ["node", "git", "gh", "herdr", "zstd", "lavish-axi", "no-mistakes", "direnv"];

const SHELL = ["sh", "env", "dirname", "realpath"];

process.env["PATH"] = [PROBES, process.env["PATH"] ?? "", STUBS].join(delimiter);

function found(tool: string): string {
  const path = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
  if (!existsSync(path)) throw new Error(`${tool} is not on the PATH of this test run`);
  return path;
}

export function pathWithout(...missing: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-tools-"));
  process.on("exit", () => {
    rmSync(dir, { recursive: true, force: true });
  });
  for (const tool of [...PREREQUISITES.filter((each) => !missing.includes(each)), ...SHELL])
    symlinkSync(found(tool), join(dir, tool));
  return dir;
}

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [verb, dir = "", command = "", ...args] = process.argv.slice(2);
if (verb !== "exec") {
  console.error(`fake direnv: unsupported ${String(verb)}`);
  process.exit(2);
}
const envrc = join(dir, ".envrc");
const env: Record<string, string | undefined> = { ...process.env };
if (existsSync(envrc)) {
  for (const line of readFileSync(envrc, "utf8").split("\n")) {
    const found = /^export ([A-Z_]+)=(.*)$/.exec(line.trim());
    if (found?.[1] !== undefined) env[found[1]] = found[2] ?? "";
  }
}
const run = spawnSync(command, args, { env, stdio: "inherit" });
process.exit(run.status ?? 1);

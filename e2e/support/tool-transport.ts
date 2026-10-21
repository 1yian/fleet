import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathWithout } from "./tool-stubs.ts";

const [marker = "", command = ""] = process.argv.slice(2);
const missing = readFileSync(marker, "utf8").split("\n").filter(Boolean);
const run = spawnSync("/bin/sh", ["-c", command], {
  encoding: "utf8",
  env: { ...process.env, PATH: pathWithout(...missing) },
});
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 255);

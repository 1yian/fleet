import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const DELAY_MS = 2000;

const [marker = "", command = ""] = process.argv.slice(2);
const started = `${marker}.started`;
if (existsSync(started)) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
if (existsSync(marker) && command.includes("'herdr' 'agent' 'start'"))
  writeFileSync(started, "started\n");
const run = spawnSync("sh", ["-c", command], { encoding: "utf8" });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 255);

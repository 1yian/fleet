import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [control = "", command = ""] = process.argv.slice(2);
const maintenance = command.includes("'up' '--maintenance'");
const run = spawnSync("sh", ["-c", command], { encoding: "utf8" });

function nextFault(): string {
  if (!existsSync(control)) return "whole";
  const [first = "whole", ...rest] = readFileSync(control, "utf8").split("\n").filter(Boolean);
  writeFileSync(control, rest.join("\n"));
  return first;
}

const fault = maintenance ? nextFault() : "whole";
if (maintenance) appendFileSync(`${control}.log`, `${fault}\n`);
if (fault === "cut") process.stdout.write(run.stdout.slice(0, run.stdout.length / 2));
else if (fault === "partial") process.stdout.write('[{"lane":"far"}]\n');
else if (fault === "nested") process.stdout.write('[{"lane":"far","action":"unread"}]\n');
else if (fault !== "blank") process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(fault === "down" ? 255 : fault === "failed" ? 1 : (run.status ?? 1));

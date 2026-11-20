import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [control = "", command = ""] = process.argv.slice(2);
const run = spawnSync("sh", ["-c", command], { encoding: "utf8" });

function nextFault(): string | undefined {
  if (!existsSync(control)) return undefined;
  const [first, ...rest] = readFileSync(control, "utf8").split("\n").filter(Boolean);
  if (first === undefined) return undefined;
  if (!first.endsWith("*")) writeFileSync(control, rest.map((line) => `${line}\n`).join(""));
  return first.replace(/\*$/, "");
}

const reads = run.status === 0 && command.includes("'up' '--maintenance'");
const fault = reads ? nextFault() : undefined;
if (reads) appendFileSync(`${control}.log`, `${fault ?? "whole"}\n`);
if (fault === "blank") process.stdout.write("");
else if (fault === "cut") process.stdout.write(run.stdout.slice(0, run.stdout.length / 2));
else process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 255);

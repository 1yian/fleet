import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [usage = "", log = "", command = ""] = process.argv.slice(2);

const hold = `${usage}.hold`;
const brokenLanes = `${usage}.lanes-fail`;
const brokenListings = `${usage}.largest-fails`;

function listingFails(): boolean {
  if (!existsSync(brokenListings)) return false;
  const left = Number(readFileSync(brokenListings, "utf8"));
  if (!(left > 0)) return false;
  writeFileSync(brokenListings, String(left - 1));
  return true;
}

function waitWhileHeld(): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (existsSync(hold)) Atomics.wait(pause, 0, 0, 50);
}

if (command.includes("'scratch'")) {
  const largest = command.includes("'--largest'");
  const tidy = command.includes("'--tidy'") ? " tidy" : "";
  appendFileSync(log, `${largest ? "largest" : "probe"}${tidy}\n`);
  if (largest) waitWhileHeld();
  if (largest && listingFails()) process.stdout.write("the host is too busy to count\n");
  else process.stdout.write(readFileSync(largest ? `${usage}.largest` : usage, "utf8"));
} else if (command.includes("'--maintenance'") && existsSync(brokenLanes)) {
  process.stderr.write("fleet up: the workspace of ops has no pane\n");
  process.exit(1);
} else {
  const run = spawnSync("sh", ["-c", command], { encoding: "utf8" });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exit(run.status ?? 255);
}

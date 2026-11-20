import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const [marker = "", command = ""] = process.argv.slice(2);
const starts = `${marker}.starts`;
const released = `${marker}.released`;
const replacement = existsSync(marker) && command.includes("'herdr' 'agent' 'start'");
if (replacement) {
  if (readFileSync(marker, "utf8").trim() === "refuse") {
    process.stderr.write(
      JSON.stringify({
        code: "agent_pane_busy",
        message: "fixture refused the start --fleet-token fixture-secret",
      }),
    );
    process.exit(1);
  }
  appendFileSync(starts, "start\n");
}
if (existsSync(starts) && command.includes("'herdr' 'pane' 'process-info'")) {
  while (!existsSync(released)) await delay(20);
}
const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
if (replacement) {
  while (!existsSync(released)) await delay(20);
  process.stderr.write(`worker readiness confirmation failed\n${result.stderr}`);
  process.exit(1);
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 255);

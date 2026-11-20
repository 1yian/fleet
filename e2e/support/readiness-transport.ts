import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parseRecord, records } from "./json.ts";

function showsPi(stdout: string): boolean {
  if (stdout.trim() === "") return false;
  const reply = parseRecord(stdout);
  const [result] = records([reply["result"]]);
  const [info] = records([result?.["process_info"]]);
  return records(info?.["foreground_processes"]).some(
    (process) => process["argv0"] === "pi" || process["name"] === "pi",
  );
}

const [marker = "", command = ""] = process.argv.slice(2);
const starts = `${marker}.starts`;
const released = `${marker}.released`;
const observed = `${marker}.observed`;
const attaching = `${marker}.attaching`;
const errorSent = `${marker}.readiness-error`;
const mode = existsSync(marker) ? readFileSync(marker, "utf8").trim() : undefined;
const competing = mode === "competing";
const replacement = mode !== undefined && command.includes("'herdr' 'agent' 'start'");
if (replacement) {
  if (mode === "refuse") {
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
const afterStart = existsSync(starts);
const processInfo = command.includes("'herdr' 'pane' 'process-info'");
if (mode !== "visible" && !competing && afterStart && processInfo) {
  while (!existsSync(released)) await delay(20);
}
const prematureAttach = competing && afterStart && command.includes("'contain' 'attach'");
if (prematureAttach) writeFileSync(attaching, "attach\n");
const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
if (competing && processInfo && afterStart && result.status === 0 && showsPi(result.stdout))
  writeFileSync(observed, "Pi visible to the mate\n");
if (replacement) {
  while (!existsSync(released)) await delay(20);
  while (competing && !(existsSync(observed) && existsSync(attaching))) await delay(20);
  process.stderr.write(
    `worker readiness confirmation failed --fleet-token fixture-secret\n${result.stderr}`,
  );
  if (mode === "visible" || competing) writeFileSync(errorSent, "readiness error emitted\n");
  process.exit(1);
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 255);

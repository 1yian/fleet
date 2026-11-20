import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const [marker = "", command = ""] = process.argv.slice(2);
const starts = `${marker}.starts`;
const released = `${marker}.released`;
const mode = existsSync(marker) ? readFileSync(marker, "utf8").trim() : undefined;
const replacement = mode !== undefined && command.includes("'herdr' 'agent' 'start'");
const refusal = {
  error: {
    code: "agent_pane_busy",
    message: "fixture refused the start --fleet-token fixture-secret",
    metadata: "stdout-fixture-metadata",
  },
};
if (replacement) {
  if (mode === "refuse") {
    process.stdout.write(JSON.stringify(refusal));
    process.stderr.write("fixture transport warning --fleet-token transport-fixture-secret\n");
    process.exit(1);
  }
  appendFileSync(starts, "start\n");
  appendFileSync(
    `${marker}.launched`,
    `${/--fleet-process=([0-9a-f-]+)/.exec(command)?.[1] ?? ""}\n`,
  );
  if (mode === "refuse-late") {
    while (!existsSync(released)) await delay(20);
    process.stdout.write(JSON.stringify(refusal));
    process.exit(1);
  }
}
if (mode === "refuse" && command.includes("'herdr' 'pane' 'read'")) {
  process.stdout.write("Idle shell context --fleet-token pane-fixture-secret\n");
  process.exit(0);
}
const afterStart = existsSync(starts);
if (mode === "contain-fail" && afterStart && command.includes("'contain' 'attach'")) {
  process.stderr.write("fixture containment failed --fleet-token containment-fixture-secret\n");
  process.exit(1);
}
const processInfo = command.includes("'herdr' 'pane' 'process-info'");
if (mode !== "visible" && mode !== "contain-fail" && afterStart && processInfo) {
  while (!existsSync(released)) await delay(20);
}
const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
if (replacement) {
  while (!existsSync(released)) await delay(20);
  const timeout = { error: { code: "timeout", message: "timed out waiting for agent startup" } };
  process.stderr.write(
    `worker readiness confirmation failed --fleet-token fixture-secret\n${JSON.stringify({ ...timeout, id: "cli:agent:start" })}\n`,
  );
  process.exit(1);
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 255);

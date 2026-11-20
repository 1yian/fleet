import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const [control = "", command = ""] = process.argv.slice(2);
const maintenance = command.includes("'up' '--maintenance'");
const option = "--maintenance-outcomes-v1";
const capabilityFile = `${control}.capability`;
const mode = existsSync(capabilityFile) ? readFileSync(capabilityFile, "utf8") : "";
if (!maintenance && command.endsWith(`'${option}'`) && mode !== "") {
  appendFileSync(`${control}.probes`, `${mode}\n`);
  if (mode === "ambiguous") {
    console.log("fleet: maintenance outcomes");
    process.exit(0);
  }
  try {
    parseArgs({
      args: [option],
      allowPositionals: true,
      options: { maintenance: { type: "boolean" } },
    });
  } catch (error) {
    console.error(`fleet: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
if (maintenance && mode === "legacy" && command.endsWith(`'${option}'`))
  throw new Error("typed maintenance was sent to an old host");
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
else if (fault === "failure-only") process.stdout.write('{"failed":"obsolete envelope"}\n');
else if (fault === "legacy-failure")
  process.stderr.write("legacy maintenance could not acquire the lane lock\n");
else if (fault === "failed-partial")
  process.stdout.write(
    '{"failed":"unconfirmed mutation","outcomes":[{"lane":"unconfirmed","action":"started"}]}\n',
  );
else if (fault === "failure-with-start" || fault === "operation-failure")
  process.stdout.write(
    `${JSON.stringify({
      failed: "could not acquire the next lane's lifecycle lock",
      outcomes: fault === "failure-with-start" ? [{ lane: "far", action: "started" }] : [],
    })}\n`,
  );
else if (fault !== "blank") process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(
  fault === "down"
    ? 255
    : ["failed", "failed-partial", "legacy-failure"].includes(fault)
      ? 1
      : (run.status ?? 1),
);

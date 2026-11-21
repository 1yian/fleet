import { parseRecord, records } from "./json.ts";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const [control = "", command = ""] = process.argv.slice(2);
const maintenance = command.includes("'up' '--maintenance'");
const option = "--maintenance-outcomes-v1";
const capabilityFile = `${control}.capability`;
const mode = existsSync(capabilityFile) ? readFileSync(capabilityFile, "utf8") : "";
if (
  !maintenance &&
  command.endsWith(`'${option}'`) &&
  mode === "hang-once" &&
  !existsSync(`${control}.pid`)
) {
  writeFileSync(`${control}.pid`, String(process.pid));
  process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 60_000);
  await new Promise<never>(() => undefined);
}
if (
  !maintenance &&
  command.endsWith(`'${option}'`) &&
  (mode === "legacy" || mode === "ambiguous")
) {
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
if (maintenance && mode === "legacy" && command.includes(`'${option}'`))
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
else if (fault === "partial")
  process.stdout.write('{"expected":["far"],"outcomes":[{"lane":"far"}]}\n');
else if (["nested", "omit-row", "omit-all", "duplicate-row", "wrong-row"].includes(fault)) {
  const reply = parseRecord(run.stdout.trim().split("\n").at(-1) ?? "");
  const outcomes = records(reply["outcomes"]);
  const [first, second] = outcomes;
  if (fault === "nested" && first !== undefined) first["action"] = "unread";
  if (fault === "omit-row") reply["outcomes"] = outcomes.slice(0, -1);
  if (fault === "omit-all") reply["outcomes"] = [];
  if (fault === "duplicate-row") reply["outcomes"] = [first, first];
  if (fault === "wrong-row" && second !== undefined) second["lane"] = "unlisted";
  process.stdout.write(`${JSON.stringify(reply)}\n`);
} else if (fault === "failure-only") process.stdout.write('{"failed":"obsolete envelope"}\n');
else if (fault === "legacy-failure")
  process.stderr.write("legacy maintenance could not acquire the lane lock\n");
else if (fault === "failed-partial")
  process.stdout.write(
    '{"failed":"unconfirmed mutation","expected":["unconfirmed"],"outcomes":[{"lane":"unconfirmed","action":"started"}]}\n',
  );
else if (fault === "failure-with-start" || fault === "operation-failure")
  process.stdout.write(
    `${JSON.stringify({
      failed: "could not acquire the next lane's lifecycle lock",
      expected: ["far", "spare"],
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

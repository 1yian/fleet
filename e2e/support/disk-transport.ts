import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const [usage = "", log = "", command = ""] = process.argv.slice(2);

if (command.includes("'scratch'")) {
  const largest = command.includes("'--largest'");
  const tidy = command.includes("'--tidy'") ? " tidy" : "";
  appendFileSync(log, `${largest ? "largest" : "probe"}${tidy}\n`);
  process.stdout.write(readFileSync(largest ? `${usage}.largest` : usage, "utf8"));
} else {
  const run = spawnSync("sh", ["-c", command], { encoding: "utf8" });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exit(run.status ?? 255);
}

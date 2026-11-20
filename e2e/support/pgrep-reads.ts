import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [control = "", real = ""] = process.argv.slice(2);
const args = (process.env["PGREP_ARGS"] ?? "").split("\n");
const mode = existsSync(control) ? readFileSync(control, "utf8").trim() : "";
appendFileSync(`${control}.log`, `${mode === "" ? "whole" : mode}\n`);

if (mode === "kill") process.kill(process.pid, "SIGKILL");
if (mode === "fail") {
  process.stderr.write("pgrep: cannot get process list\n");
  process.exit(3);
}
if (mode === "none") process.exit(1);
if (mode === "hang") {
  setTimeout(() => {
    process.exit(0);
  }, 60_000);
} else {
  const run = spawnSync(real, args, { encoding: "utf8" });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exit(run.status ?? 255);
}

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathWithout } from "./tool-stubs.ts";

const [marker = "", command = ""] = process.argv.slice(2);
const faults = existsSync(marker) ? readFileSync(marker, "utf8").split("\n") : [];
const env = { ...process.env };
if (faults.includes("restart-lacks-direnv") && command.includes("'restart'"))
  env["PATH"] = pathWithout("direnv");
if (faults.includes("arrange-lacks-session") && command.includes("'arrange'"))
  env["HERDR_SESSION"] = "not a session";
const run = spawnSync("sh", ["-c", command], { encoding: "utf8", env });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 255);

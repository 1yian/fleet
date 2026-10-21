import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const [marker = "", command = ""] = process.argv.slice(2);
const run = spawnSync("sh", ["-c", command], { encoding: "utf8" });
if (run.status === 0 && command.startsWith("'herdr' 'agent' 'start'") && !existsSync(marker)) {
  writeFileSync(marker, "dropped once\n");
  process.exit(255);
}
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 255);

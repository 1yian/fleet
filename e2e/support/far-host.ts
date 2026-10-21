import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const [marker = "", mount = "", disk = "", command = ""] = process.argv.slice(2);
if (existsSync(marker)) {
  process.stderr.write("ssh: connect to host far port 22: Operation timed out\n");
  process.exit(255);
}
const run = spawnSync("sh", ["-c", command.replaceAll(mount, `${disk}${mount}`)], {
  encoding: "utf8",
});
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 255);

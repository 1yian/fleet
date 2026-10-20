// A host transport for a host that can go down: it runs the command here, like
// ssh to a healthy host, until the marker file exists. Then it fails the way ssh
// does when the host cannot be reached, with exit status 255.
// Usage, in FLEET_HOSTS: ["node", "<this file>", "<marker file>"]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const [marker = "", command = ""] = process.argv.slice(2);
if (existsSync(marker)) {
  process.stderr.write("ssh: connect to host far port 22: Operation timed out\n");
  process.exit(255);
}
const run = spawnSync("sh", ["-c", command], { encoding: "utf8" });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 255);

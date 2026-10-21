import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const [marker = "", command = ""] = process.argv.slice(2);
const down = existsSync(marker) ? readFileSync(marker, "utf8") : undefined;
if (down?.startsWith("hang") === true) {
  setTimeout(() => process.exit(255), 300_000);
} else if (down?.startsWith("flood") === true && !command.startsWith("'herdr'")) {
  process.stdout.write("x".repeat(20_000_000));
} else if (down !== undefined && !down.startsWith("flood")) {
  process.stderr.write("ssh: connect to host far port 22: Operation timed out\n");
  process.exit(255);
} else {
  const run = spawnSync("sh", ["-c", command], { encoding: "utf8" });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exit(run.status ?? 255);
}

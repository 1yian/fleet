import { spawnSync } from "node:child_process";

const [path = "", command = ""] = process.argv.slice(2);
const run = spawnSync("/bin/sh", ["-c", command], {
  encoding: "utf8",
  env: { ...process.env, PATH: path },
});
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 255);

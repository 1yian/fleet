import { spawnSync } from "node:child_process";

const [home = "", tmp = "", command = ""] = process.argv.slice(2);

const login = { HOME: home, PATH: process.env["PATH"] ?? "", FLEET_TMP_SOURCE_DIR: tmp };
const reachesTheLabsHerdr = command.includes("'herdr'") || command.includes("'arrange'");

const run = spawnSync("sh", ["-c", command], {
  encoding: "utf8",
  env: reachesTheLabsHerdr ? process.env : login,
});
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 255);

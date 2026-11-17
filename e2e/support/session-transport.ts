import { spawnSync } from "node:child_process";

const [session = "", main = "", command = ""] = process.argv.slice(2);
const run = spawnSync("sh", ["-c", command.split(main).join(session)], {
  encoding: "utf8",
  env: { ...process.env, HERDR_SESSION: session },
});
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 255);

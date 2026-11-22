import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

const [log = "", stub = "", upstreamMarker = "", command = ""] = process.argv.slice(2);
appendFileSync(log, `${JSON.stringify(command)}\n`);
const upstream = upstreamMarker !== "" && existsSync(upstreamMarker);
const path = upstream
  ? `${stub}:${(await import("./tool-stubs.ts")).pathWithout("no-mistakes")}`
  : process.env["PATH"];
const run = spawnSync("/bin/sh", ["-c", command], {
  encoding: "utf8",
  env: { ...process.env, ...(path === undefined ? {} : { PATH: path }) },
});
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 255);

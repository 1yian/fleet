// Starts a mate: Pi with the fleet extension, in the current folder (the lane's
// home), with the lane's settings from ~/.config/fleet/<lane>.json:
//   { "url": "ws://<cardd>/session", "token": "...", "model": "tier/default",
//     "hosts": { "p620": ["ssh", "p620"] }, "workerArgs": ["--model", "tier/quick"] }
// Usage: node launch.ts <lane> [extra pi arguments]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION = fileURLToPath(new URL("./index.ts", import.meta.url));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each) => typeof each === "string") : [];

const [lane, ...extra] = process.argv.slice(2);
if (lane === undefined || lane === "") throw new Error("usage: fleet <lane> [pi arguments]");
const file = join(homedir(), ".config", "fleet", `${lane}.json`);
const config: unknown = JSON.parse(readFileSync(file, "utf8"));
if (!isRecord(config) || typeof config["url"] !== "string" || typeof config["token"] !== "string") {
  throw new Error(`${file} needs "url" and "token"`);
}
const model = typeof config["model"] === "string" ? ["--model", config["model"]] : [];
// Workers get the extension the same way, plus their own model arguments.
const workerArgs = ["-e", EXTENSION, ...strings(config["workerArgs"])];
const args = [
  "-e",
  EXTENSION,
  "--fleet-url",
  config["url"],
  "--fleet-token",
  config["token"],
  "--fleet-role",
  "mate",
];
const env = {
  ...process.env,
  FLEET_PI_ARGS: JSON.stringify(workerArgs),
  FLEET_HOSTS: JSON.stringify(isRecord(config["hosts"]) ? config["hosts"] : {}),
};
const result = spawnSync("pi", [...args, ...model, ...extra], { stdio: "inherit", env });
process.exit(result.status ?? 1);

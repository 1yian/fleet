import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, optionalNumber, optionalString } from "./json.ts";

const [dir = "", ...argv] = process.argv.slice(2);
const calls = join(dir, "calls.jsonl");
const index = existsSync(calls)
  ? readFileSync(calls, "utf8")
      .split("\n")
      .filter((line) => line !== "").length
  : 0;
appendFileSync(calls, `${JSON.stringify({ argv })}\n`);

const plan: unknown = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
const steps = Array.isArray(plan) ? plan.filter(isRecord) : [];
const step = steps[Math.min(index, steps.length - 1)] ?? {};
const said = optionalString(step, "say");
if (said !== undefined) process.stderr.write(`${said}\n`);

if (step["stay"] === true) {
  process.on("SIGTERM", () => {
    appendFileSync(join(dir, "terminated"), "x");
    process.exit(143);
  });
  setInterval(() => undefined, 1000);
} else {
  process.exit(optionalNumber(step, "exit") ?? 0);
}

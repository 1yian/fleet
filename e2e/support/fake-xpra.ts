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
const pieces = Array.isArray(step["pieces"]) ? step["pieces"].map(String) : [];
const stream = step["to"] === "stdout" ? process.stdout : process.stderr;

async function speak(): Promise<void> {
  for (const [piece, text] of pieces.entries()) {
    while (piece > 0 && !existsSync(join(dir, `release-${String(index)}-${String(piece)}`)))
      await new Promise((resolve) => setTimeout(resolve, 10));
    stream.write(text);
  }
}

if (pieces.length > 0) {
  void speak().then(() => {
    process.exit(optionalNumber(step, "exit") ?? 0);
  });
} else if (step["stay"] === true) {
  process.on("SIGTERM", () => {
    appendFileSync(join(dir, "terminated"), "x");
    process.exit(143);
  });
  setInterval(() => undefined, 1000);
} else {
  process.exit(optionalNumber(step, "exit") ?? 0);
}

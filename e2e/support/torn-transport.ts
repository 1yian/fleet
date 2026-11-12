import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { isRecord, parseRecord, records, type JsonRecord } from "./json.ts";

const TORN_MS = 2500;

const [marker = "", command = ""] = process.argv.slice(2);
const run = spawnSync("sh", ["-c", command], { encoding: "utf8" });

const runsPi = (each: JsonRecord): boolean =>
  each["name"] === "pi" ||
  (Array.isArray(each["argv"]) && each["argv"].some((arg) => basename(String(arg)) === "pi"));

function tornReply(stdout: string): string {
  const reply = parseRecord(stdout);
  const result = reply["result"];
  const info = isRecord(result) ? result["process_info"] : undefined;
  if (!isRecord(info)) return stdout;
  const processes = records(info["foreground_processes"]);
  if (!processes.some(runsPi)) return stdout;
  if (!existsSync(marker)) {
    writeFileSync(marker, String(Date.now()));
    return stdout;
  }
  if (Date.now() - Number(readFileSync(marker, "utf8")) > TORN_MS) return stdout;
  appendFileSync(`${marker}.torn`, "torn\n");
  info["foreground_processes"] = processes.map((each) =>
    runsPi(each) ? { ...each, name: "node", argv: undefined } : each,
  );
  return JSON.stringify(reply);
}

const reply = run.status === 0 && command.includes("'process-info'");
process.stdout.write(reply ? tornReply(run.stdout) : run.stdout);
process.stderr.write(run.stderr);
process.exit(run.status ?? 255);

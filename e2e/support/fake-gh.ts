// A fake gh for tests. It keeps PR state in the JSON file named by FAKE_GH_STATE:
// { "<url>": { "state": "OPEN" | "MERGED" | "CLOSED", "checks": [{ "name", "bucket" }] } }
import { readFileSync, writeFileSync } from "node:fs";
import { isRecord, records } from "./json.ts";

const file = process.env["FAKE_GH_STATE"] ?? "";
const prs: unknown = JSON.parse(readFileSync(file, "utf8"));
const [noun, verb, url = ""] = process.argv.slice(2);
const pr = isRecord(prs) && isRecord(prs[url]) ? prs[url] : undefined;
if (noun !== "pr" || pr === undefined || !isRecord(prs)) {
  console.error(`fake gh: no PR ${url}`);
  process.exit(1);
}
if (verb === "view") console.log(JSON.stringify({ state: pr["state"] }));
if (verb === "checks") {
  const checks = records(pr["checks"]);
  console.log(JSON.stringify(checks));
  process.exitCode = checks.some((check) => check["bucket"] === "fail") ? 1 : 0;
}
if (verb === "merge") {
  if (pr["state"] !== "OPEN") process.exit(1);
  writeFileSync(file, JSON.stringify({ ...prs, [url]: { ...pr, state: "MERGED" } }));
  console.log(`merged ${url}`);
}

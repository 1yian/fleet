import { appendFileSync, readFileSync } from "node:fs";
import { isRecord, parseRecord, publishRecord } from "./json.ts";

const file = process.env["FAKE_GH_STATE"] ?? "";
appendFileSync(`${file}.log`, `${process.argv.slice(2).join(" ")}\n`);
const prs = parseRecord(readFileSync(file, "utf8"));
const [noun, verb, url = ""] = process.argv.slice(2);
const pr = prs[url];
if (noun !== "pr" || (verb !== "merge" && verb !== "view") || !isRecord(pr)) {
  console.error(`fake gh: ${process.argv.slice(2).join(" ")} is not a known PR`);
  process.exit(1);
}
if (pr["account"] !== undefined && pr["account"] !== process.env["GH_TOKEN"]) {
  console.error("GraphQL: Could not resolve to a PullRequest with the requested URL");
  process.exit(1);
}
if (verb === "view") {
  console.log(JSON.stringify({ url, state: pr["state"] }));
  process.exit(0);
}
if (pr["state"] !== "OPEN") process.exit(1);
publishRecord(file, { ...prs, [url]: { ...pr, state: "MERGED" } });
console.log(`merged ${url}`);

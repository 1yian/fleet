import { appendFileSync, readFileSync } from "node:fs";
import { isRecord, parseRecord, publishRecord } from "./json.ts";

const file = process.env["FAKE_GH_STATE"] ?? "";
appendFileSync(`${file}.log`, `${process.argv.slice(2).join(" ")}\n`);
const prs = parseRecord(readFileSync(file, "utf8"));
const [noun, verb, url = ""] = process.argv.slice(2);
const pr = prs[url];
if (noun !== "pr" || verb !== "merge" || !isRecord(pr)) {
  console.error(`fake gh: ${process.argv.slice(2).join(" ")} is not a merge of a known PR`);
  process.exit(1);
}
if (pr["state"] !== "OPEN") process.exit(1);
publishRecord(file, { ...prs, [url]: { ...pr, state: "MERGED" } });
console.log(`merged ${url}`);

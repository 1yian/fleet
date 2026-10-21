import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isRecord, parseRecord, records } from "./json.ts";

const file = process.env["FAKE_GH_STATE"] ?? "";
const prs = parseRecord(readFileSync(file, "utf8"));
const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: { repo: { type: "string" }, head: { type: "string" } },
});
const [noun, verb, url = ""] = positionals;
const log = (mark: "+" | "-"): void => {
  appendFileSync(`${file}.log`, `${mark} ${String(process.pid)}\n`);
};
const delay = prs["$delay"];
log("+");
if (typeof delay === "number") await new Promise((resolve) => setTimeout(resolve, delay));
process.on("exit", () => {
  log("-");
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const down = (pr: Record<string, unknown>): void => {
  if (pr["down"] === true) fail("HTTP 502: Bad Gateway");
};

if (noun === "pr" && verb === "list") {
  const repo = `https://github.com/${String(values.repo)}/pull/`;
  const found = Object.entries(prs)
    .flatMap(([each, pr]) => (isRecord(pr) ? [{ url: each, pr }] : []))
    .filter((each) => each.url.startsWith(repo) && each.pr["head"] === values.head)
    .reverse();
  for (const each of found) down(each.pr);
  console.log(
    JSON.stringify(found.slice(0, 1).map((each) => ({ url: each.url, state: each.pr["state"] }))),
  );
  process.exit(0);
}

const pr = prs[url];
if (noun !== "pr" || !isRecord(pr)) fail(`fake gh: no PR ${url}`);
down(pr);
if (verb === "view") console.log(JSON.stringify({ url, state: pr["state"] }));
if (verb === "checks") {
  if (pr["broken"] === true) fail("HTTP 502: Bad Gateway");
  const checks = records(pr["checks"]);
  if (checks.length === 0) fail("no checks reported on the 'feature' branch");
  console.log(JSON.stringify(checks));
  process.exitCode = checks.some((check) => check["bucket"] === "fail") ? 1 : 0;
}
if (verb === "merge") {
  if (pr["state"] !== "OPEN") process.exit(1);
  writeFileSync(file, JSON.stringify({ ...prs, [url]: { ...pr, state: "MERGED" } }));
  console.log(`merged ${url}`);
}

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { isRecord, parseRecord, publishRecord } from "./json.ts";

const file = process.env["FAKE_GH_STATE"] ?? "";
const argv = process.argv.slice(2);
appendFileSync(`${file}.log`, `${argv.join(" ").replaceAll("\n", "\\n")}\n`);
const [noun, verb, url = ""] = argv;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function flag(name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

function linesOf(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];
}

function brokenWith(what: string): string | undefined {
  const marker = `${file}.broken-${what}`;
  return existsSync(marker) ? readFileSync(marker, "utf8") : undefined;
}

if (noun === "label" && verb === "create") {
  const broken = brokenWith("labels");
  if (broken !== undefined) fail(broken);
  const repo = flag("--repo");
  if (url === "" || repo === undefined) fail("fake gh: label create needs a name and --repo");
  if (!linesOf(`${file}.labels`).includes(url)) appendFileSync(`${file}.labels`, `${url}\n`);
  console.log(`Label "${url}" created in ${repo}`);
  process.exit(0);
}

if (noun === "issue" && verb === "create") {
  const broken = brokenWith("issues");
  if (broken !== undefined) fail(broken);
  const repo = flag("--repo");
  const title = flag("--title");
  const body = flag("--body");
  const label = flag("--label");
  if (repo === undefined || title === undefined || body === undefined)
    fail("fake gh: issue create needs --repo, --title, and --body");
  if (label !== undefined && !linesOf(`${file}.labels`).includes(label))
    fail(`could not add label: '${label}' not found`);
  appendFileSync(
    `${file}.issues`,
    `${JSON.stringify({ repo, title, body, labels: label === undefined ? [] : [label] })}\n`,
  );
  console.log(`https://github.com/${repo}/issues/${String(linesOf(`${file}.issues`).length)}`);
  process.exit(0);
}

const prs = parseRecord(readFileSync(file, "utf8"));
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

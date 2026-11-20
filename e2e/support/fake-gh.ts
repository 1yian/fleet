import { appendFileSync, existsSync, readFileSync, watch } from "node:fs";
import { dirname } from "node:path";
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

if (noun === "issue" && verb === "create") {
  const hold = `${file}.hold-issues`;
  if (existsSync(hold)) {
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (existsSync(hold)) return;
        watcher.close();
        resolve();
      };
      const watcher = watch(dirname(hold), check);
      check();
    });
  }
  const broken = `${file}.broken-issues`;
  if (existsSync(broken)) fail(readFileSync(broken, "utf8"));
  const target = flag("--repo");
  const title = flag("--title");
  const body = flag("--body");
  if (target === undefined || title === undefined || body === undefined)
    fail("fake gh: issue create needs --repo, --title, and --body");
  const repo =
    target.split("/").length === 2 ? `${process.env["GH_HOST"] ?? "github.com"}/${target}` : target;
  appendFileSync(`${file}.issues`, `${JSON.stringify({ repo, title, body })}\n`);
  console.log(`https://${repo}/issues/${String(linesOf(`${file}.issues`).length)}`);
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

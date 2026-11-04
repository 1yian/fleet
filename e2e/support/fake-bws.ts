import { appendFileSync } from "node:fs";
import { isRecord, parseRecord } from "./json.ts";

const data = parseRecord(process.env["FAKE_BWS_DATA"] ?? "{}");
const log = process.env["FAKE_BWS_LOG"];
const args = process.argv.slice(2);
if (log !== undefined)
  appendFileSync(
    log,
    `${JSON.stringify({ args, token: process.env["BWS_ACCESS_TOKEN"] === data["token"] })}\n`,
  );

const TRAILER = [
  "",
  "Location:",
  "   crates/bws/src/main.rs:68",
  "",
  "Backtrace omitted. Run with RUST_BACKTRACE=1 environment variable to display it.",
  "Run with RUST_BACKTRACE=full to include source snippets.",
];
function fail(reason: string): never {
  console.error(["Error: ", `   0: ${reason}`, ...TRAILER].join("\n"));
  process.exit(1);
}

if (typeof data["outage"] === "string") fail(data["outage"]);
if (process.env["BWS_ACCESS_TOKEN"] !== data["token"])
  fail(`[401 Unauthorized] the access token ${process.env["BWS_ACCESS_TOKEN"] ?? ""} was refused`);

const words: string[] = [];
for (let at = 0; at < args.length; at += 1) {
  const arg = args[at] ?? "";
  if (arg === "--color" || arg === "--output") at += 1;
  else words.push(arg);
}
const [noun, verb, target] = words;
const projects = Array.isArray(data["projects"]) ? data["projects"].filter(isRecord) : [];
const secrets = (project: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(project["secrets"]) ? project["secrets"].filter(isRecord) : [];
const shaped = (project: Record<string, unknown>, secret: Record<string, unknown>): unknown => ({
  object: "secret",
  id: secret["id"],
  projectId: project["id"],
  key: secret["key"],
  value: secret["value"],
});

if (noun === "secret" && verb === "list") {
  const project = projects.find((each) => each["id"] === target);
  if (project === undefined) fail("project not found");
  console.log(JSON.stringify(secrets(project).map((secret) => shaped(project, secret))));
} else if (noun === "secret" && verb === "get") {
  for (const project of projects) {
    const secret = secrets(project).find((each) => each["id"] === target);
    if (secret !== undefined) {
      console.log(JSON.stringify(shaped(project, secret)));
      process.exit(0);
    }
  }
  fail("secret not found");
} else {
  console.error(`fake bws: ${words.join(" ")} is not supported`);
  process.exit(2);
}

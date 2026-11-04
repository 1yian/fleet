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

if (typeof data["outage"] === "string") {
  console.error(data["outage"]);
  process.exit(1);
}
if (process.env["BWS_ACCESS_TOKEN"] !== data["token"]) {
  console.error(
    `Error: [401 Unauthorized] the access token ${process.env["BWS_ACCESS_TOKEN"] ?? ""} was refused`,
  );
  process.exit(1);
}

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
  if (project === undefined) {
    console.error("Error: project not found");
    process.exit(1);
  }
  console.log(JSON.stringify(secrets(project).map((secret) => shaped(project, secret))));
} else if (noun === "secret" && verb === "get") {
  for (const project of projects) {
    const secret = secrets(project).find((each) => each["id"] === target);
    if (secret !== undefined) {
      console.log(JSON.stringify(shaped(project, secret)));
      process.exit(0);
    }
  }
  console.error("Error: secret not found");
  process.exit(1);
} else {
  console.error(`fake bws: ${words.join(" ")} is not supported`);
  process.exit(2);
}

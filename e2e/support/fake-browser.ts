import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { parseRecord, type JsonRecord } from "./json.ts";
import { tempDir } from "./run-root.ts";

const SCRIPT = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const sha = (text) => createHash("sha256").update(String(text)).digest("hex");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const envelope = JSON.parse(input);
  const call = {
    argv: process.argv.slice(2),
    secretInEnv: Object.values(process.env).some((value) => sha(value) === process.env.FAKE_BROWSER_SECRET_SHA256),
    secretInArgv: process.argv.some((value) => sha(value) === process.env.FAKE_BROWSER_SECRET_SHA256),
    stdinIsTty: process.stdin.isTTY === true,
    keys: Object.keys(envelope).sort(),
    lane: envelope.lane,
    origin: envelope.origin,
    url: envelope.url,
    username: envelope.username,
    passwordSha256: sha(envelope.password),
  };
  appendFileSync(process.env.FAKE_BROWSER_LOG, JSON.stringify(call) + "\\n");
  process.stdout.write("login: " + (process.env.FAKE_BROWSER_OUTCOME || "done") + "\\n");
});
`;

export class FakeBrowser {
  readonly dir = tempDir("fleet-fake-browser-");
  readonly log = join(this.dir, "calls.jsonl");
  readonly env: Record<string, string>;

  constructor(secret: string, outcome = "done") {
    const script = join(this.dir, "fleet-browser");
    writeFileSync(script, SCRIPT);
    chmodSync(script, 0o755);
    this.env = {
      PATH: [this.dir, process.env["PATH"] ?? ""].join(delimiter),
      FAKE_BROWSER_LOG: this.log,
      FAKE_BROWSER_OUTCOME: outcome,
      FAKE_BROWSER_SECRET_SHA256: createHash("sha256")
        .update(secret)
        .digest("hex"),
    };
  }

  calls(): JsonRecord[] {
    if (!existsSync(this.log)) return [];
    return readFileSync(this.log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map(parseRecord);
  }
}

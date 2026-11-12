import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const HELD_LONGEST_MS = 120_000;

const [dir = "", ...argv] = process.argv.slice(2);
let rest = argv;
while (rest[0] === "-o") rest = rest.slice(2);
const [host = "", ...command] = rest;
appendFileSync(join(dir, "ssh.jsonl"), `${JSON.stringify({ host, command: command.join(" ") })}\n`);

if (existsSync(join(dir, "ssh-held"))) {
  process.on("SIGTERM", () => {
    appendFileSync(join(dir, "ssh-terminated"), "x");
    process.exit(143);
  });
  setTimeout(() => process.exit(255), HELD_LONGEST_MS);
} else {
  const child = spawn("sh", ["-c", command.join(" ")], { stdio: "inherit" });
  child.on("exit", (code) => {
    process.exit(code ?? 255);
  });
}

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const [dir = "", ...argv] = process.argv.slice(2);
let rest = argv;
while (rest[0] === "-o") rest = rest.slice(2);
const [host = "", ...command] = rest;
appendFileSync(join(dir, "ssh.jsonl"), `${JSON.stringify({ host, command: command.join(" ") })}\n`);

const child = spawn("sh", ["-c", command.join(" ")], { stdio: "inherit" });
child.on("exit", (code) => {
  process.exit(code ?? 255);
});

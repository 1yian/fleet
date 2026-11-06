import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir = "", ...argv] = process.argv.slice(2);
const options: string[] = [];
let rest = argv;
while (rest[0] === "-o") {
  options.push(rest[1] ?? "");
  rest = rest.slice(2);
}
const [host = "", command = ""] = rest;
const direct = options.includes("ControlMaster=no") && options.includes("ControlPath=none");
const modeFile = join(dir, "mode");
const mode = existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "healthy";

appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify({ host, direct, command })}\n`);

const refuses = (): void => {
  process.stderr.write(
    "mm_send_fd: sendmsg(0): Message too long\nmux_client_request_session: send fds failed\n",
  );
  process.exit(255);
};
const timesOut = (): void => {
  process.stderr.write(`ssh: connect to host ${host} port 22: Operation timed out\n`);
  process.exit(255);
};

if (mode === "down" || (mode === "wedged-down" && direct)) timesOut();
if ((mode === "wedged" || mode === "wedged-down") && !direct) refuses();

const child = spawn("sh", ["-c", command], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 143));
});

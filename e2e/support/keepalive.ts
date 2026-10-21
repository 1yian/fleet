import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidFile = "", command = "", ...args] = process.argv.slice(2);
let child: ChildProcess | undefined;

function run(): void {
  const started = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
  child = started;
  writeFileSync(pidFile, String(started.pid));
  started.once("exit", () => setTimeout(run, 200));
}

process.once("SIGTERM", () => {
  child?.kill("SIGKILL");
  process.exit(0);
});
run();

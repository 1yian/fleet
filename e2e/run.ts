import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-timeout=300000", "e2e/**/*.test.ts"],
  { stdio: "inherit", detached: true },
);
const deadline = setTimeout(() => {
  console.error("End-to-end suite exceeded 30 minutes, including teardown");
  if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
}, 30 * 60_000);
child.on("error", (error) => {
  console.error(error);
  clearTimeout(deadline);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  clearTimeout(deadline);
  process.exitCode = code ?? 1;
});

import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-timeout=300000", "e2e/**/*.test.ts"],
  { stdio: "inherit", detached: true },
);
const killGroup = (signal: NodeJS.Signals): void => {
  if (child.pid !== undefined) process.kill(-child.pid, signal);
};
const deadline = setTimeout(() => {
  console.error("End-to-end suite exceeded 60 minutes, including teardown");
  killGroup("SIGKILL");
}, 60 * 60_000);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    process.exitCode = 1;
    killGroup(signal);
  });
}
child.on("error", (error) => {
  console.error(error);
  clearTimeout(deadline);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  clearTimeout(deadline);
  process.exitCode = code ?? 1;
});

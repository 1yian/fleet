import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [host = "", log = "", ...rest] = process.argv.slice(2);
const command = rest.at(-1) ?? "";
const settings = Object.fromEntries(
  rest
    .slice(0, -1)
    .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)] as const),
);

appendFileSync(log, `${JSON.stringify({ host, command })}\n`);

const child = spawn("sh", ["-c", command], {
  stdio: "inherit",
  env: { ...process.env, ...settings },
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 143));
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

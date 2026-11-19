import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("go version go1.25.0 fake/fake");
  process.exit(0);
}
const flags = args[args.indexOf("-ldflags") + 1] ?? "";
const pick = (name: string): string =>
  new RegExp(`buildinfo\\.${name}=(\\S+)`).exec(flags)?.[1] ?? "";
const out = args[args.indexOf("-o") + 1];
if (args[0] !== "build" || out === undefined || process.env["CGO_ENABLED"] !== "0") {
  console.error(`fake go: unexpected invocation: ${args.join(" ")}`);
  process.exit(1);
}
writeFileSync(
  out,
  `#!/bin/sh\necho "no-mistakes version ${pick("Version")} (${pick("Commit")}) ${pick("Date")}"\n`,
  { mode: 0o755 },
);

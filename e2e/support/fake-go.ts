import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("go version go1.25.0 fake/fake");
  process.exit(0);
}
const MODULE = "github.com/kunchenguid/no-mistakes";
const flags = args[args.indexOf("-ldflags") + 1] ?? "";
const symbols = new Map(
  [...flags.matchAll(/-X (\S+)=(\S+)/g)].map(([, name = "", value = ""]): [string, string] => [
    name,
    value,
  ]),
);
const stamp = (name: string): string => symbols.get(`${MODULE}/internal/buildinfo.${name}`) ?? "";
const out = args[args.indexOf("-o") + 1];
const entry = "cmd/no-mistakes";
const buildable =
  args[0] === "build" &&
  args.at(-1) === `./${entry}` &&
  out !== undefined &&
  process.env["CGO_ENABLED"] === "0" &&
  existsSync("go.mod") &&
  readFileSync("go.mod", "utf8").startsWith(`module ${MODULE}\n`) &&
  existsSync(entry) &&
  readdirSync(entry).some((name) => name.endsWith(".go")) &&
  ["Version", "Commit", "Date"].every((name) => stamp(name) !== "");
if (!buildable) {
  console.error(`fake go: unbuildable invocation in ${process.cwd()}: ${args.join(" ")}`);
  process.exit(1);
}
writeFileSync(
  out,
  `#!/bin/sh\necho "no-mistakes version ${stamp("Version")} (${stamp("Commit")}) ${stamp("Date")}"\n`,
  { mode: 0o755 },
);

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("go version go1.25.0 fake/fake");
  process.exit(0);
}
const MODULE = "github.com/kunchenguid/no-mistakes";
const ENTRY = "cmd/no-mistakes";
const BUILDINFO = "internal/buildinfo";
const SYMBOLS = ["Version", "Commit", "Date"];

const sources = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".go"))
        .map((name) => readFileSync(join(dir, name), "utf8"))
    : [];

const flags = args[args.indexOf("-ldflags") + 1] ?? "";
const stamps = new Map(
  [...flags.matchAll(/-X (\S+)=(\S+)/g)].map(([, name = "", value = ""]): [string, string] => [
    name,
    value,
  ]),
);
const stamp = (name: string): string => stamps.get(`${MODULE}/${BUILDINFO}.${name}`) ?? "";
const out = args[args.indexOf("-o") + 1];

const runnable = sources(ENTRY).some(
  (text) => /^package main$/m.test(text) && /^func main\(\) \{/m.test(text),
);
const stampable = SYMBOLS.every((name) =>
  sources(BUILDINFO).some(
    (text) => /^package buildinfo$/m.test(text) && new RegExp(`^\\t${name}\\s+= "`, "m").test(text),
  ),
);
const buildable =
  args[0] === "build" &&
  args.at(-1) === `./${ENTRY}` &&
  out !== undefined &&
  process.env["CGO_ENABLED"] === "0" &&
  existsSync("go.mod") &&
  readFileSync("go.mod", "utf8").startsWith(`module ${MODULE}\n`) &&
  runnable &&
  stampable &&
  SYMBOLS.every((name) => stamp(name) !== "");
if (!buildable) {
  console.error(`fake go: unbuildable invocation in ${process.cwd()}: ${args.join(" ")}`);
  process.exit(1);
}
writeFileSync(
  out,
  `#!/bin/sh\necho "no-mistakes version ${stamp("Version")} (${stamp("Commit")}) ${stamp("Date")}"\n`,
  { mode: 0o755 },
);

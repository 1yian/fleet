import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./run-root.ts";

const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
export const HELPER_ERROR = "LAB-HELPER-FAILURE: pane run refused";
export const HELPER_SECRET = "sk-labSecretMustNotReachDiagnosticLogs123456";

export const FLAKY_READS = 3;

export function reloadFault() {
  const bin = tempDir("reload-fault-");
  const marker = join(bin, "pane");
  const fired = join(bin, "fired");
  const flake = join(bin, "flake");
  const flaked = join(bin, "flaked");
  const preload = join(bin, "preload.mjs");
  writeFileSync(
    preload,
    `import fs from "node:fs";
const mode = () => (fs.existsSync(${JSON.stringify(flake)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(flake)}, "utf8")) : {});
const real = globalThis.fetch;
if ((process.argv[1] ?? "").endsWith("relaunch.ts")) {
  globalThis.fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const failed = fs.existsSync(${JSON.stringify(flaked)}) ? fs.readFileSync(${JSON.stringify(flaked)}, "utf8").length : 0;
    if (body.op === "maintenance.read" && mode().pane === process.argv[3] && failed < ${String(FLAKY_READS)}) {
      fs.appendFileSync(${JSON.stringify(flaked)}, "x");
      throw new TypeError("fetch failed");
    }
    return real(input, init);
  };
}
`,
  );
  const real = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "herdr"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const mode = fs.existsSync(${JSON.stringify(marker)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(marker)}, "utf8")) : {};
if (args[0] === "pane" && args[1] === "run" && args[2] === mode.pane) {
  fs.writeFileSync(${JSON.stringify(fired)}, "fired");
  if (mode.skip) {
    console.log(JSON.stringify({ result: {} }));
    process.exit(0);
  }
  console.error(${JSON.stringify(`${HELPER_ERROR} ${HELPER_SECRET}`)});
  process.exit(42);
}
const result = require("node:child_process").spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );
  return {
    env: {
      PATH: `${bin}:${BIN}:${process.env["PATH"] ?? ""}`,
      NODE_OPTIONS: `${process.env["NODE_OPTIONS"] ?? ""} --import=${preload}`.trim(),
    },
    fail(pane: string, skip: boolean): void {
      writeFileSync(marker, JSON.stringify({ pane, skip }));
    },
    flake(pane: string): void {
      writeFileSync(flake, JSON.stringify({ pane }));
    },
    flaked(): number {
      return existsSync(flaked) ? readFileSync(flaked, "utf8").length : 0;
    },
    fired(): boolean {
      return existsSync(fired) && readFileSync(fired, "utf8") === "fired";
    },
  };
}

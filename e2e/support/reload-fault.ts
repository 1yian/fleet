import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecord } from "./json.ts";
import { until } from "./live-fleet.ts";
import { tempDir } from "./run-root.ts";

const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
export const HELPER_ERROR = "LAB-HELPER-FAILURE: pane run refused";
export const HELPER_LEAK = "labLeakMustNotReachDiagnosticLogsAbcdefgh1234";

export const FLAKY_READS = 3;

function signalHelper(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

export function reloadFault() {
  const bin = tempDir("reload-fault-");
  const marker = join(bin, "pane");
  const fired = join(bin, "fired");
  const flake = join(bin, "flake");
  const flaked = join(bin, "flaked");
  const preload = join(bin, "preload.mjs");
  const helpers = join(bin, "helpers");
  writeFileSync(
    preload,
    `import fs from "node:fs";
const mode = () => (fs.existsSync(${JSON.stringify(flake)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(flake)}, "utf8")) : {});
const real = globalThis.fetch;
if ((process.argv[1] ?? "").endsWith("relaunch.ts")) {
  fs.appendFileSync(${JSON.stringify(helpers)}, JSON.stringify({ pid: process.pid, pane: process.argv[3] }) + "\\n");
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
  console.error(${JSON.stringify(`${HELPER_ERROR} ${HELPER_LEAK}`)});
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
    async stop(): Promise<void> {
      if (!existsSync(helpers)) return;
      const pids = readFileSync(helpers, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const pid = parseRecord(line)["pid"];
          if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
            throw new Error("invalid reload helper PID");
          return pid;
        });
      for (const pid of pids) signalHelper(pid, "SIGTERM");
      await until(
        () => (pids.every((pid) => !signalHelper(pid, 0)) ? true : undefined),
        "the recorded reload helpers to exit",
      );
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

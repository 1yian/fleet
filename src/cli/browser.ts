import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { AxiError } from "axi-sdk-js";
import { DAEMON_URL } from "./client.js";

const require = createRequire(import.meta.url);

export const PASS_THROUGH = new Set([
  "open",
  "click",
  "dblclick",
  "type",
  "fill",
  "press",
  "keyboard",
  "hover",
  "focus",
  "check",
  "uncheck",
  "select",
  "drag",
  "upload",
  "download",
  "scroll",
  "scrollintoview",
  "wait",
  "screenshot",
  "pdf",
  "snapshot",
  "eval",
  "get",
  "is",
  "find",
  "mouse",
  "set",
  "network",
  "tab",
  "diff",
  "back",
  "forward",
  "reload",
  "highlight",
  "console",
  "errors",
  "batch",
  "read",
  "vitals",
  "a11y",
]);

export function browserEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "TERM"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.AGENT_BROWSER_NO_VERSION_CHECK = "1";
  env.AGENT_BROWSER_NAMESPACE = "fleet-browser";
  return env;
}

export function runAgentBrowser(
  lane: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const entry = require.resolve("agent-browser/bin/agent-browser.js");
  const cdp = `${DAEMON_URL.replace(/^http/, "ws")}/cdp/${lane}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, "--session", `fb-${lane}`, "--cdp", cdp, ...args], {
      env: browserEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) =>
      reject(new AxiError(`could not run agent-browser: ${error.message}`, "HARNESS_MISSING")),
    );
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function cleanOutput(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("[agent-browser] "))
    .join("\n");
}

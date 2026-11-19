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

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export function runAgentBrowser(lane: string, args: string[]): Promise<Run> {
  const cdp = `${DAEMON_URL.replace(/^http/, "ws")}/cdp/${lane}`;
  return runProcess(["--session", `fb-${lane}`, "--cdp", cdp, ...args], browserEnv());
}

export function runDevBrowser(name: string, args: string[]): Promise<Run> {
  const env = browserEnv();
  env.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(15 * 60 * 1000);
  const chrome = process.env.FLEET_BROWSER_DEV_CHROME;
  if (chrome) env.AGENT_BROWSER_EXECUTABLE_PATH = chrome;
  return runProcess(["--session", `fb-dev-${name}`, ...args], env);
}

export async function mergedConsole(run: (args: string[]) => Promise<Run>, args: string[]): Promise<string> {
  const [messages, errors] = await Promise.all([run(["console", ...args]), run(["errors", ...args])]);
  const failed = messages.code !== 0 ? messages : errors.code !== 0 ? errors : null;
  if (failed) throw new AxiError(cleanOutput(failed.stdout + failed.stderr).trim(), "BROWSER_COMMAND_FAILED");
  const lines = [
    cleanOutput(messages.stdout).trim(),
    cleanOutput(errors.stdout).trim().replace(/^✗ /gm, "[error] "),
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : "no console output or page errors";
}

function runProcess(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  const entry = require.resolve("agent-browser/bin/agent-browser.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env,
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

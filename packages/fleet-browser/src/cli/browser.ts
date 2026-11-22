import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { AxiError } from "axi-sdk-js";
import { DAEMON_URL, daemon } from "./client.js";

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

const NAMESPACE = "fleet-browser";
const SOCKET_PATH_LIMIT = 103;
const ATTEMPT_NAME = /^c-(\d{1,9})-a(\d{1,4})$/;

export function browserEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "TERM"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.AGENT_BROWSER_NO_VERSION_CHECK = "1";
  env.AGENT_BROWSER_NAMESPACE = NAMESPACE;
  return env;
}

function attemptName(): string | null {
  return process.env.FLEET_ATTEMPT?.trim() || null;
}

function sessionNameBudget(): number {
  const dir = `${browserEnv().HOME ?? ""}/.agent-browser/namespaces/${NAMESPACE}/run/`;
  return SOCKET_PATH_LIMIT - Buffer.byteLength(dir) - ".sock".length;
}

export function sessionName(lane: string): string {
  const attempt = attemptName();
  if (!attempt) return `fb-${lane}`;
  const parts = ATTEMPT_NAME.exec(attempt);
  const readable = parts ? `fb-${lane}_c${parts[1]}a${parts[2]}` : null;
  if (readable && readable.length <= sessionNameBudget()) return readable;
  const hash = createHash("sha256").update(`${lane}\n${attempt}`).digest("hex").slice(0, 10);
  return `fb-${lane.slice(0, 12)}_${hash}`;
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export function runAgentBrowser(lane: string, args: string[]): Promise<Run> {
  const cdp = `${DAEMON_URL.replace(/^http/, "ws")}/cdp/${lane}`;
  const pin = attemptName() ? ["--pin-tab"] : [];
  return runProcess(["--session", sessionName(lane), "--cdp", cdp, ...pin, ...args], browserEnv());
}

interface OwnTab {
  active: boolean;
  label: string | null;
  tabId: string;
  targetId: string;
}

function parseTabs(text: string): OwnTab[] | null {
  try {
    return (JSON.parse(text) as { data?: { tabs?: OwnTab[] } }).data?.tabs ?? null;
  } catch {
    return null;
  }
}

async function listOwnTabs(lane: string): Promise<OwnTab[]> {
  await daemon.start(lane);
  const run = await runAgentBrowser(lane, ["--json", "tab", "list"]);
  const tabs = run.code === 0 ? parseTabs(cleanOutput(run.stdout).trim()) : null;
  if (tabs) return tabs;
  throw new AxiError(
    cleanOutput(run.stdout + run.stderr).trim() || "could not list this card's tabs",
    "BROWSER_COMMAND_FAILED",
  );
}

export async function ownTab(lane: string): Promise<string | undefined> {
  if (!attemptName()) return undefined;
  const active = (await listOwnTabs(lane)).find((tab) => tab.active);
  if (!active) {
    throw new AxiError("this card has no open tab", "NO_TAB", [
      "Run `fleet-browser tab new <url>` to open one",
    ]);
  }
  return active.targetId;
}

async function assertOwnTab(lane: string, ref: string): Promise<void> {
  const tabs = await listOwnTabs(lane);
  const named = tabs.find((tab) => tab.tabId === ref || tab.targetId === ref || tab.label === ref);
  if (named?.active) return;
  throw new AxiError(`tab ${ref} is not this card's current tab, so it is not closed`, "TAB_NOT_OWNED", [
    "Other cards of this lane own the other tabs: leave them open",
    "Run `fleet-browser tab list`; this card's tab is the one marked active",
    "To close a tab you opened earlier, switch to it first with `fleet-browser tab <id>`, then run `fleet-browser tab close`",
  ]);
}

export async function guardTabClose(lane: string, verb: string, args: string[]): Promise<void> {
  if (!attemptName() || (verb !== "tab" && verb !== "batch")) return;
  const commands = verb === "batch" ? args.map((item) => item.trim().split(/\s+/)) : [[verb, ...args]];
  for (const words of commands) {
    if (words[0] !== "tab" || words[1] !== "close") continue;
    const ref = words.slice(2).find((word) => !word.startsWith("-"));
    if (ref) await assertOwnTab(lane, ref.replace(/^["']|["']$/g, ""));
  }
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

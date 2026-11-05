import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRecord, type JsonRecord } from "./json.ts";

const AXI = fileURLToPath(new URL("../../bin/browser-axi", import.meta.url));

export interface Access {
  readonly url: string;
  readonly token: string;
}

export interface AxiRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const FLAGS = ["card", "captain"] as const;

const text = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

function flag(name: string, value: unknown): string[] {
  if (value === undefined || value === false) return [];
  return value === true ? [`--${name}`] : [`--${name}=${text(value)}`];
}

const positional = (value: unknown): string[] => (value === undefined ? [] : ["--", text(value)]);

export function axiArgs(args: Record<string, unknown>, json = true): string[] {
  const action = String(args["action"]);
  const common = FLAGS.flatMap((name) => flag(name, args[name]));
  const own: string[] = (() => {
    switch (action) {
      case "open":
        return positional(args["url"]);
      case "read":
        return [...flag("selector", args["selector"]), ...flag("html", args["html"])];
      case "click":
        return [
          ...flag("selector", args["selector"]),
          ...flag("x", args["x"]),
          ...flag("y", args["y"]),
        ];
      case "type":
        return [
          ...flag("text", args["text"]),
          ...flag("selector", args["selector"]),
          ...flag("submit", args["submit"]),
        ];
      case "press":
        return positional(args["key"]);
      case "eval":
        return positional(args["expression"]);
      case "screenshot":
        return flag("full-page", args["fullPage"]);
      case "login":
        return flag("site", args["site"]);
      default:
        return [];
    }
  })();
  const tail = own.indexOf("--");
  const flags = tail < 0 ? own : own.slice(0, tail);
  const rest = tail < 0 ? [] : own.slice(tail);
  return [action, ...common, ...flags, ...(json ? ["--json"] : []), ...rest];
}

export function runAxi(
  args: readonly string[],
  access: Access | undefined,
  env: Record<string, string> = {},
  cwd?: string,
): Promise<AxiRun> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith("HERDR_") &&
        !entry[0].startsWith("FLEET_BROWSER_"),
    ),
  );
  const given =
    access === undefined
      ? {}
      : { FLEET_BROWSER_URL: access.url, FLEET_BROWSER_TOKEN: access.token };
  return new Promise((resolve) => {
    execFile(
      AXI,
      [...args],
      {
        env: { ...base, ...given, ...env },
        encoding: "utf8",
        ...(cwd === undefined ? {} : { cwd }),
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

export function recordOf(run: AxiRun): JsonRecord {
  return parseRecord(run.stdout);
}

class AxiError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

async function axiRecord(
  access: Access,
  args: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<JsonRecord> {
  const run = await runAxi(axiArgs(args), access, env);
  assert.equal(run.stderr, "", "browser-axi wrote to stderr");
  const record = recordOf(run);
  if (typeof record["error"] === "string") throw new AxiError(record["error"], run.code);
  return record;
}

export async function axiAct(access: Access, args: Record<string, unknown>): Promise<string> {
  return String((await axiRecord(access, args))["result"]);
}

export async function axiShot(access: Access, fullPage = false): Promise<string> {
  const record = await axiRecord(access, { action: "screenshot", fullPage });
  const file = record["image"];
  if (typeof file !== "string") throw new Error("the screenshot came back without a picture");
  return readFileSync(file).toString("base64");
}

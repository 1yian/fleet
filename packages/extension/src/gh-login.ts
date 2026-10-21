import { isRecord } from "./lane-config.ts";

export type GhLogin =
  | { readonly state: "logged-in" }
  | { readonly state: "logged-out" }
  | { readonly state: "unknown"; readonly reason: string };

export interface GhRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | undefined;
  readonly timedOut: boolean;
  readonly spawnError: string | undefined;
}

export type RunGh = (args: readonly string[]) => GhRun;

const NOT_LOGGED_IN = /not logged into any/i;
const REJECTED = /status code: 401\b|\bHTTP 401\b/;
const TOKEN = /\b(gh[pousr]_|github_pat_)\w*/g;
const REASON_LIMIT = 200;

const unknown = (reason: string): GhLogin => ({ state: "unknown", reason });

function firstLine(text: string): string {
  const line = text.split("\n").find((each) => each.trim() !== "") ?? "";
  const hidden = line.trim().replace(TOKEN, "$1***");
  return hidden.length > REASON_LIMIT ? `${hidden.slice(0, REASON_LIMIT)}...` : hidden;
}

function entriesOf(output: string): Record<string, unknown>[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  const hosts = isRecord(parsed) ? parsed["hosts"] : undefined;
  if (!isRecord(hosts)) return undefined;
  return Object.entries(hosts).flatMap(([host, entries]) =>
    Array.isArray(entries) ? entries.filter(isRecord).map((entry) => ({ ...entry, host })) : [],
  );
}

function judgeEntry(entry: Record<string, unknown>): GhLogin | undefined {
  const host = String(entry["host"]);
  const error = typeof entry["error"] === "string" ? entry["error"] : "";
  switch (entry["state"]) {
    case "success":
      return undefined;
    case "refresh_expired":
      return { state: "logged-out" };
    case "timeout":
      return unknown(`${host}: timed out`);
    case "error":
      return REJECTED.test(error)
        ? { state: "logged-out" }
        : unknown(`${host}: ${firstLine(error) || "gh reported an error"}`);
    default:
      return unknown(`${host}: gh reported an unrecognized state`);
  }
}

function judgeJson(output: string): GhLogin | undefined {
  const entries = entriesOf(output);
  if (entries === undefined) return undefined;
  if (entries.length === 0) return { state: "logged-out" };
  const verdicts = entries.flatMap((entry) => judgeEntry(entry) ?? []);
  return (
    verdicts.find((verdict) => verdict.state === "logged-out") ??
    verdicts[0] ??
    unknown("gh auth status failed, but every account then checked out")
  );
}

function judgeText(failure: GhRun): GhLogin {
  const output = `${failure.stderr}\n${failure.stdout}`;
  if (NOT_LOGGED_IN.test(output)) return { state: "logged-out" };
  return unknown(
    `gh auth status exited ${String(failure.code)}: ${firstLine(output) || "no output"}`,
  );
}

export function ghLogin(run: RunGh, timeoutSeconds: number): GhLogin {
  const first = run(["auth", "status"]);
  if (first.spawnError !== undefined) return unknown(firstLine(first.spawnError));
  if (first.timedOut)
    return unknown(`gh auth status did not finish within ${String(timeoutSeconds)}s`);
  if (first.code === 0) return { state: "logged-in" };
  if (first.code !== 1) return judgeText(first);
  const second = run(["auth", "status", "--json", "hosts"]);
  if (second.code === 0 && !second.timedOut) {
    const judged = judgeJson(second.stdout);
    if (judged !== undefined) return judged;
  }
  return judgeText(first);
}

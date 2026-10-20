// gh, the GitHub command line (spec section 5). cardd reads PR state for the
// timed check and runs the guarded merge.
import { execFile } from "node:child_process";

export interface PullRequest {
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  /** Checks that failed, and checks that have not reported yet. */
  readonly failed: readonly string[];
  readonly pending: readonly string[];
}

function gh(args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("gh", args, { encoding: "utf8", timeout: 60_000 }, (error, out, err) => {
      resolve({
        code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
        out,
        err,
      });
    });
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const NO_CHECKS = /no checks reported/i;

async function readState(url: string): Promise<PullRequest["state"]> {
  const view = await gh(["pr", "view", url, "--json", "state"]);
  const parsed: unknown = view.code === 0 ? JSON.parse(view.out) : undefined;
  const state = isRecord(parsed) ? parsed["state"] : undefined;
  if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") {
    throw new Error(`gh pr view ${url} failed: ${view.err.trim() || view.out.trim()}`);
  }
  return state;
}

/** The checks as JSON. A failed read is an error, not an empty list; only gh's "no checks reported" is empty. */
async function readChecks(url: string): Promise<Record<string, unknown>[]> {
  const checks = await gh(["pr", "checks", url, "--json", "name,bucket"]);
  if (checks.out.trim() === "") {
    if (checks.code !== 0 && !NO_CHECKS.test(checks.err))
      throw new Error(`gh pr checks ${url} failed: ${checks.err.trim()}`);
    return [];
  }
  const list: unknown = JSON.parse(checks.out);
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

/** The PR's state and checks. gh exits non-zero while checks fail or pend, so the JSON decides. */
export async function readPullRequest(url: string): Promise<PullRequest> {
  const state = await readState(url);
  const items = state === "OPEN" ? await readChecks(url) : [];
  const named = (bucket: string[]): string[] =>
    items
      .filter((item) => bucket.includes(String(item["bucket"])))
      .map((item) => String(item["name"]));
  return { state, failed: named(["fail", "cancel"]), pending: named(["pending"]) };
}

export async function mergePullRequest(url: string): Promise<void> {
  const merged = await gh(["pr", "merge", url, "--squash"]);
  if (merged.code !== 0)
    throw new Error(`gh pr merge ${url} failed: ${merged.err.trim() || merged.out.trim()}`);
}

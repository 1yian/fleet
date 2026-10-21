import { execFile } from "node:child_process";

export interface PullRequest {
  readonly url: string;
  readonly state: "OPEN" | "MERGED" | "CLOSED";
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

function listed(item: unknown, branch: string): Pick<PullRequest, "url" | "state"> {
  const url = isRecord(item) ? item["url"] : undefined;
  const state = isRecord(item) ? item["state"] : undefined;
  if (typeof url !== "string" || (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED"))
    throw new Error(`gh pr list --head ${branch} gave an unknown PR: ${JSON.stringify(item)}`);
  return { url, state };
}

async function findOnBranch(
  repo: string,
  branch: string,
): Promise<Pick<PullRequest, "url" | "state"> | undefined> {
  const args = ["pr", "list", "--repo", repo, "--head", branch, "--state", "all"];
  const list = await gh([...args, "--json", "url,state", "--limit", "1"]);
  const parsed: unknown = list.code === 0 ? JSON.parse(list.out) : undefined;
  if (!Array.isArray(parsed))
    throw new Error(`gh pr list --head ${branch} failed: ${list.err.trim() || list.out.trim()}`);
  const first: unknown = parsed[0];
  return first === undefined ? undefined : listed(first, branch);
}

export async function findPullRequest(
  repo: string,
  branches: readonly string[],
): Promise<PullRequest | undefined> {
  for (const branch of branches) {
    const found = await findOnBranch(repo, branch);
    if (found === undefined) continue;
    const items = found.state === "OPEN" ? await readChecks(found.url) : [];
    const named = (bucket: string[]): string[] =>
      items
        .filter((item) => bucket.includes(String(item["bucket"])))
        .map((item) => String(item["name"]));
    return { ...found, failed: named(["fail", "cancel"]), pending: named(["pending"]) };
  }
  return undefined;
}

const GITHUB_REMOTE = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/;

export function repoOfRemote(url: string): string | undefined {
  return GITHUB_REMOTE.exec(url.trim())?.[1];
}

import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";

const GITHUB_REMOTE = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/;

const repoOfRemote = (url: string): string | undefined => GITHUB_REMOTE.exec(url.trim())?.[1];

export function recordReportedPr(db: DatabaseSync, card: number, url: string | undefined): void {
  if (url === undefined) return;
  const repo = db
    .prepare(
      "SELECT p.repo AS repo FROM cards c JOIN projects p ON p.name = c.project WHERE c.id = ?",
    )
    .get(card)?.["repo"];
  if (
    typeof repo === "string" &&
    !url.toLowerCase().startsWith(`https://github.com/${repo}/pull/`.toLowerCase())
  )
    throw new Error(`${url} is not a PR of this project's repository ${repo}`);
  db.prepare("UPDATE cards SET pr = ? WHERE id = ?").run(url, card);
}

export type Hosts = Readonly<Record<string, readonly string[]>>;

const ORIGIN_TIMEOUT_MS = 30_000;

const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

function originOn(hosts: Hosts, host: string, clone: string): Promise<string | undefined> {
  const argv = ["git", "-C", clone, "remote", "get-url", "origin"];
  const via = hosts[host] ?? [];
  const [file = "git", ...args] = via.length === 0 ? argv : [...via, argv.map(quote).join(" ")];
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout: ORIGIN_TIMEOUT_MS }, (error, out) => {
      resolve(error === null ? repoOfRemote(out) : undefined);
    });
  });
}

async function repoOfClones(hosts: Hosts, clones: unknown): Promise<string | undefined> {
  const entries = typeof clones === "object" && clones !== null ? Object.entries(clones) : [];
  const found = await Promise.all(
    entries.flatMap(([host, path]) =>
      typeof path === "string" ? [originOn(hosts, host, path)] : [],
    ),
  );
  return found.find((repo) => repo !== undefined);
}

export const projectsWithoutRepo = (db: DatabaseSync): { name: string; clones: unknown }[] =>
  db
    .prepare("SELECT name, clones FROM projects WHERE repo IS NULL")
    .all()
    .map((row) => {
      const clones: unknown = JSON.parse(String(row["clones"]));
      return { name: String(row["name"]), clones };
    });

export async function fillRepo(
  db: DatabaseSync,
  hosts: Hosts,
  project: { name: string; clones: unknown },
): Promise<void> {
  const repo = await repoOfClones(hosts, project.clones);
  if (repo !== undefined)
    db.prepare("UPDATE projects SET repo = ? WHERE name = ? AND repo IS NULL").run(
      repo,
      project.name,
    );
}

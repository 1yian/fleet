import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { findPullRequest, repoOfRemote, type PullRequest } from "./github.ts";

export type PrLookup =
  | { readonly kind: "found"; readonly pr: PullRequest }
  | { readonly kind: "none"; readonly branches: readonly string[] }
  | { readonly kind: "unknown"; readonly reason: string };

function placeOf(db: DatabaseSync, card: number): { repo: string | null; branches: string[] } {
  const repo = db
    .prepare(
      "SELECT p.repo AS repo FROM cards c JOIN projects p ON p.name = c.project WHERE c.id = ?",
    )
    .get(card)?.["repo"];
  const branches = db
    .prepare("SELECT branch FROM attempts WHERE card = ? AND branch IS NOT NULL ORDER BY n DESC")
    .all(card)
    .map((row) => String(row["branch"]));
  return { repo: typeof repo === "string" ? repo : null, branches };
}

export async function lookUpPr(db: DatabaseSync, card: number): Promise<PrLookup> {
  const { repo, branches } = placeOf(db, card);
  if (repo === null)
    return { kind: "unknown", reason: "its project has no GitHub repository on record" };
  if (branches.length === 0) return { kind: "none", branches };
  try {
    const pr = await findPullRequest(repo, branches);
    if (pr === undefined) return { kind: "none", branches };
    db.prepare("UPDATE cards SET pr = ? WHERE id = ? AND pr IS NOT ?").run(pr.url, card, pr.url);
    return { kind: "found", pr };
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
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

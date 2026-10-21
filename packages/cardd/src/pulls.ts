import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

export function fillRepos(db: DatabaseSync): void {
  const projects = db.prepare("SELECT name, clones FROM projects WHERE repo IS NULL").all();
  for (const project of projects) {
    const clones: unknown = JSON.parse(String(project["clones"]));
    const paths = typeof clones === "object" && clones !== null ? Object.values(clones) : [];
    const repo = paths
      .filter((path): path is string => typeof path === "string" && existsSync(path))
      .map(originOf)
      .find((each) => each !== undefined);
    if (repo !== undefined)
      db.prepare("UPDATE projects SET repo = ? WHERE name = ?").run(repo, String(project["name"]));
  }
}

function originOf(clone: string): string | undefined {
  try {
    const url = execFileSync("git", ["-C", clone, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return repoOfRemote(url);
  } catch {
    return undefined;
  }
}

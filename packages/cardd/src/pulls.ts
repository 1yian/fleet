import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { findPullRequest, repoOfRemote, viewPullRequest, type PullRequest } from "./github.ts";

export type PrLookup =
  | { readonly kind: "found"; readonly pr: PullRequest }
  | { readonly kind: "none"; readonly branches: readonly string[] }
  | { readonly kind: "unknown"; readonly reason: string };

interface Place {
  readonly repo: string | null;
  readonly pr: string | null;
  readonly branches: string[];
}

function placeOf(db: DatabaseSync, card: number): Place {
  const row = db
    .prepare(
      "SELECT p.repo AS repo, c.pr AS pr FROM cards c LEFT JOIN projects p ON p.name = c.project WHERE c.id = ?",
    )
    .get(card);
  const branches = db
    .prepare("SELECT branch FROM attempts WHERE card = ? AND branch IS NOT NULL ORDER BY n DESC")
    .all(card)
    .map((each) => String(each["branch"]));
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return { repo: text(row?.["repo"]), pr: text(row?.["pr"]), branches };
}

async function findOrView({ repo, pr, branches }: Place): Promise<PrLookup> {
  if (repo === null) {
    if (pr === null)
      return { kind: "unknown", reason: "its project has no GitHub repository on record" };
    return { kind: "found", pr: await viewPullRequest(pr) };
  }
  if (branches.length === 0) return { kind: "none", branches };
  const found = await findPullRequest(repo, branches);
  return found === undefined ? { kind: "none", branches } : { kind: "found", pr: found };
}

interface Slot {
  running: Promise<PrLookup> | undefined;
  queued: Promise<PrLookup> | undefined;
}

const slots = new Map<number, Slot>();

export function lookUpPr(db: DatabaseSync, card: number): Promise<PrLookup> {
  const slot: Slot = slots.get(card) ?? { running: undefined, queued: undefined };
  slots.set(card, slot);
  if (slot.queued !== undefined) return slot.queued;
  const start = (): Promise<PrLookup> => {
    slot.queued = undefined;
    const run = readPr(db, card);
    slot.running = run;
    void run.finally(() => {
      slot.running = undefined;
      if (slot.queued === undefined) slots.delete(card);
    });
    return run;
  };
  if (slot.running === undefined) return start();
  slot.queued = slot.running.then(start);
  return slot.queued;
}

async function readPr(db: DatabaseSync, card: number): Promise<PrLookup> {
  try {
    const found = await findOrView(placeOf(db, card));
    if (found.kind === "found")
      db.prepare("UPDATE cards SET pr = ? WHERE id = ? AND pr IS NOT ?").run(
        found.pr.url,
        card,
        found.pr.url,
      );
    return found;
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

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ADD_WORKTREE, SYNC_FUNCTIONS } from "../clones.ts";
import { openChecked, showInstead } from "./editor.ts";
import { git, gitOrNothing, gitPaths } from "./git.ts";
import { decide, resolved, skillRelative } from "./places.ts";
import { PROJECTS_UNAVAILABLE, type LocalClone, type World } from "./world.ts";

export const scratchPath = (clone: LocalClone): string => `${clone.path}.worktrees/scratch`;

export const baseOf = (clone: LocalClone): string =>
  clone.delivery === "local-only" ? clone.base : `origin/${clone.base}`;

function normalizedRemote(url: string): string {
  const bare = url
    .trim()
    .replace(/^[a-z][a-z+.-]*:\/\//i, "")
    .replace(/^[^@/]+@/, "");
  const path = /^[^/:]+:(?!\/)/.test(bare) ? bare.replace(":", "/") : bare;
  return path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function originOf(dir: string): string | undefined {
  const url = gitOrNothing(dir, "remote", "get-url", "origin");
  return url === undefined ? undefined : normalizedRemote(url);
}

function repositoryOf(dir: string): string | undefined {
  const common = gitOrNothing(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common === undefined ? undefined : resolved(common);
}

function cloneOfCheckout(world: World, inside: string): LocalClone | undefined {
  const repository = repositoryOf(inside);
  const same = world.clones.find(
    (clone) => repository !== undefined && repositoryOf(clone.path) === repository,
  );
  if (same !== undefined) return same;
  const origin = originOf(inside);
  if (origin === undefined) return undefined;
  return world.clones.find((clone) => originOf(clone.path) === origin);
}

function newBranch(world: World, repository: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
  const named = `scratch/${world.host}-${stamp}`;
  const taken = (name: string): boolean =>
    gitOrNothing(repository, "show-ref", "--verify", "--quiet", `refs/heads/${name}`) !== undefined;
  let name = named;
  for (let again = 2; taken(name); again += 1) name = `${named}-${String(again)}`;
  return name;
}

function isWorktreeOf(clone: string, path: string): boolean {
  const listed = gitOrNothing(clone, "worktree", "list", "--porcelain") ?? "";
  const here = resolved(path);
  return listed
    .split("\n")
    .some((line) => line.startsWith("worktree ") && resolved(line.slice(9)) === here);
}

function ensureScratch(world: World, clone: LocalClone): string {
  const path = scratchPath(clone);
  if (existsSync(path)) {
    if (!isWorktreeOf(clone.path, path))
      throw new Error(`${path} exists and is not a worktree of ${clone.path}`);
    return path;
  }
  const branch = newBranch(world, clone.path);
  const from = clone.delivery === "local-only" ? "local" : "origin";
  try {
    execFileSync(
      "sh",
      ["-c", ADD_WORKTREE, "add", clone.path, path, branch, clone.base, from, "scratch"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    throw new Error(stderr.trim() || `could not make the scratch worktree ${path}`, {
      cause: error,
    });
  }
  const commit = git(path, "rev-parse", "--short=12", "HEAD");
  console.log(`creating the scratch worktree of ${clone.project}: ${path}`);
  console.log(`branch ${branch}, from ${baseOf(clone)} at ${commit}`);
  return path;
}

interface Standing {
  readonly branch: string;
  readonly ahead: number;
  readonly behind: number;
  readonly dirty: number;
  readonly merged: boolean;
}

function holdsNothingNew(path: string, base: string): boolean {
  const fork = gitOrNothing(path, "merge-base", base, "HEAD");
  if (fork === undefined) return false;
  const mine = gitPaths(path, "diff", "--name-only", "--no-renames", fork, "HEAD");
  const unlanded = gitPaths(path, "diff", "--name-only", "--no-renames", base, "HEAD");
  if (mine === undefined || unlanded === undefined) return false;
  const left = new Set(unlanded);
  return mine.every((file) => !left.has(file));
}

export function standingOf(clone: LocalClone, path: string): Standing {
  const branch = git(path, "rev-parse", "--abbrev-ref", "HEAD");
  const base = baseOf(clone);
  const counts = gitOrNothing(path, "rev-list", "--left-right", "--count", `${base}...HEAD`);
  const [behind = 0, ahead = 0] = (counts ?? "0 0").split(/\s+/).map(Number);
  const dirty = git(path, "status", "--porcelain").split("\n").filter(Boolean).length;
  return { branch, ahead, behind, dirty, merged: holdsNothingNew(path, base) };
}

function standingLine(clone: LocalClone, path: string): string {
  const { branch, ahead, behind, dirty, merged } = standingOf(clone, path);
  const state =
    dirty > 0
      ? "reset refuses while the scratch is dirty"
      : merged
        ? "reset allowed"
        : "has commits that are not merged, reset refuses";
  return `${clone.project}: ${path} on ${branch}, ${String(ahead)} ahead and ${String(behind)} behind ${baseOf(clone)}, ${String(dirty)} dirty files, ${state}`;
}

export function scratchLines(world: World): string[] {
  const lines = world.clones
    .filter((clone) => existsSync(scratchPath(clone)))
    .map((clone) => standingLine(clone, scratchPath(clone)));
  return lines.length > 0 ? lines : ["no scratch worktree on this host yet: E makes one"];
}

function fetched(clone: LocalClone): void {
  execFileSync(
    "sh",
    [
      "-c",
      `${SYNC_FUNCTIONS}\nfetch_origin "$1" || { echo "$fetched" >&2; exit 1; }`,
      "fetch",
      clone.path,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

export function resetScratch(world: World, project: string | undefined): string[] {
  const clones = world.clones.filter(
    (clone) =>
      existsSync(scratchPath(clone)) && (project === undefined || clone.project === project),
  );
  if (clones.length === 0) throw new Error("no scratch worktree to reset");
  return clones.map((clone) => {
    const path = scratchPath(clone);
    if (clone.delivery !== "local-only") fetched(clone);
    const { branch, dirty, merged } = standingOf(clone, path);
    if (dirty > 0) throw new Error(`${clone.project}: ${path} has ${String(dirty)} dirty files`);
    if (!merged) throw new Error(`${clone.project}: ${branch} has commits that are not merged`);
    const next = newBranch(world, path);
    const start = baseOf(clone);
    git(path, "switch", "--no-track", "-c", next, start);
    git(path, "branch", "-D", branch);
    return `${clone.project}: ${path} is on ${next} from ${start}, and ${branch} is deleted`;
  });
}

export function pushScratch(world: World, inside: string): string {
  const folder = existsSync(inside) && !statSync(inside).isDirectory() ? dirname(inside) : inside;
  const root = gitOrNothing(folder, "rev-parse", "--show-toplevel");
  const clone = world.clones.find(
    (each) => root !== undefined && resolved(root) === resolved(scratchPath(each)),
  );
  if (clone === undefined || root === undefined)
    throw new Error("this is not a scratch worktree, so there is nothing to push");
  const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
  const script = `${SYNC_FUNCTIONS}\nfetched=$(git_net "$1" push -u origin "$2") || { echo "$fetched" >&2; exit 1; }`;
  execFileSync("sh", ["-c", script, "push", root, branch], { stdio: ["ignore", "pipe", "pipe"] });
  return `pushed ${branch} to origin/${branch}`;
}

export interface Workshop {
  readonly clone: LocalClone;
  readonly skills: string;
  readonly scratch: string;
}

function checkoutOf(skills: string): Workshop["scratch"] | undefined {
  const top = gitOrNothing(dirname(skills), "rev-parse", "--show-toplevel");
  return top !== undefined && resolved(top) === resolved(dirname(skills)) ? top : undefined;
}

export function workshopOf(world: World): Workshop | undefined {
  const loaded = world.lane.args.flatMap((arg, at) =>
    world.lane.args[at - 1] === "--skill" ? [resolve(arg)] : [],
  );
  for (const skills of loaded) {
    const scratch = checkoutOf(skills);
    const clone = scratch === undefined ? undefined : cloneOfCheckout(world, scratch);
    if (scratch !== undefined && clone !== undefined && resolved(scratch) !== resolved(clone.path))
      return { clone, skills, scratch };
  }
  for (const clone of world.clones)
    if (loaded.includes(join(scratchPath(clone), "skills")))
      return { clone, skills: join(scratchPath(clone), "skills"), scratch: scratchPath(clone) };
  return undefined;
}

interface Mapped {
  readonly scratch: string;
  readonly target: string;
  readonly note: string;
}

function noteOf(scratch: string, checkout?: string): string {
  const branch = git(scratch, "rev-parse", "--abbrev-ref", "HEAD");
  const head = checkout === undefined ? undefined : gitOrNothing(checkout, "rev-parse", "HEAD");
  const ahead =
    head === undefined ? undefined : gitOrNothing(scratch, "rev-list", "--count", `${head}..HEAD`);
  return Number(ahead) > 0
    ? `${branch}, ${ahead ?? ""} commits ahead of this lane's checkout`
    : branch;
}

function mappedTarget(world: World, path: string): Mapped {
  const checkout = gitOrNothing(dirname(resolved(path)), "rev-parse", "--show-toplevel");
  const clone = checkout === undefined ? undefined : cloneOfCheckout(world, checkout);
  if (checkout === undefined || clone === undefined)
    throw new Error(
      world.projectsKnown
        ? "this host has no clone of the repository this file belongs to: register one first (docs/setup.md, section 3)"
        : PROJECTS_UNAVAILABLE,
    );
  const scratch = ensureScratch(world, clone);
  const target = join(scratch, relative(resolved(checkout), resolved(path)));
  return { scratch, target, note: noteOf(scratch, checkout) };
}

function skillTarget(world: World, path: string): Mapped | undefined {
  const workshop = workshopOf(world);
  const inside = skillRelative(path);
  if (workshop === undefined || inside === undefined) return undefined;
  const scratch = existsSync(workshop.scratch)
    ? workshop.scratch
    : ensureScratch(world, workshop.clone);
  return { scratch, target: join(scratch, "skills", inside), note: noteOf(scratch) };
}

const REFUSED = {
  worker: "a worker owns this worktree. S shows a file to this lane's mate",
  skill: "skills are edited in the lane that owns them. M sends a request to main",
};

export function editInScratch(world: World, path: string): number {
  const decision = decide(world, path);
  if (decision.editable) return openChecked(world, path, decision);
  if (decision.kind === "worker") return refuse(REFUSED.worker);
  if (decision.kind === "unknown") return refuse(decision.why);
  const instead = showInstead(path);
  if (instead !== undefined) return instead;
  const mapped = decision.kind === "skill" ? skillTarget(world, path) : mappedTarget(world, path);
  if (mapped === undefined) return refuse(REFUSED.skill);
  return openChecked(
    world,
    mapped.target,
    decide(world, mapped.target),
    mapped.note,
    mapped.scratch,
  );
}

function refuse(reason: string): number {
  console.error(`fleet files: ${reason}`);
  return 1;
}

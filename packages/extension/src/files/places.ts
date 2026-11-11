import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { laneHomes } from "../homes.ts";
import type { World } from "./world.ts";

type Kind = "root" | "home" | "clone" | "worker" | "skill";

export type Decision =
  | { readonly editable: true }
  | { readonly editable: false; readonly kind: Kind; readonly why: string };

interface Place {
  readonly kind: Exclude<Kind, "skill">;
  readonly real: string;
  readonly why: string;
}

const WORKER_FOLDER = /^c-\d+-a\d+$/;

export const under = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

export function resolved(path: string): string {
  const missing: string[] = [];
  let dir = resolve(path);
  while (!existsSync(dir)) {
    missing.unshift(basename(dir));
    dir = dirname(dir);
  }
  return join(realpathSync(dir), ...missing);
}

export function skillFolders(): string[] {
  const agent = process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  return [join(homedir(), ".agents", "skills"), join(agent, "skills")];
}

function realOrNothing(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function insideFolder(folder: string, path: string, real: string): string | undefined {
  if (under(resolve(path), folder)) return relative(folder, resolve(path));
  const top = realOrNothing(folder);
  if (top === undefined) return undefined;
  if (under(real, top)) return relative(top, real);
  for (const name of readdirSync(folder)) {
    const entry = realOrNothing(join(folder, name));
    if (entry !== undefined && under(real, entry)) return join(name, relative(entry, real));
  }
  return undefined;
}

export function skillRelative(path: string): string | undefined {
  const real = resolved(path);
  for (const folder of skillFolders()) {
    const inside = insideFolder(folder, path, real);
    if (inside !== undefined) return inside;
  }
  return undefined;
}

function placesOf(world: World): Place[] {
  const workers = world.clones.flatMap(({ path }) => {
    const folder = `${path}.worktrees`;
    if (!existsSync(folder)) return [];
    return readdirSync(folder)
      .filter((name) => WORKER_FOLDER.test(name))
      .map((name) => ({
        kind: "worker" as const,
        real: resolved(join(folder, name)),
        why: `inside worker worktree ${name}, which its worker owns`,
      }));
  });
  const homes = laneHomes(world.root).map(({ home, lane }) => ({
    kind: "home" as const,
    real: resolved(home),
    why: `tracked in the home of lane ${lane}`,
  }));
  const root = {
    kind: "root" as const,
    real: resolved(world.root),
    why: "tracked in the fleet checkout",
  };
  const clones = world.clones.map(({ path, project }) => ({
    kind: "clone" as const,
    real: resolved(path),
    why: `tracked in the ${project} clone`,
  }));
  return [...workers, ...homes, root, ...clones];
}

function enclosing(real: string, places: readonly Place[]): Place | undefined {
  return places
    .filter((place) => under(real, place.real))
    .sort((a, b) => b.real.length - a.real.length)[0];
}

function ignoredBy(place: Place, real: string): boolean {
  const inside = relative(place.real, real);
  if (inside === "") return false;
  return spawnSync("git", ["-C", place.real, "check-ignore", "-q", "--", inside]).status === 0;
}

export function decide(world: World, path: string): Decision {
  const real = resolved(path);
  if (skillRelative(path) !== undefined)
    return {
      editable: false,
      kind: "skill",
      why: "in a released skill folder: skill text is edited only in the lane that owns the skills",
    };
  const place = enclosing(real, placesOf(world));
  if (place === undefined) return { editable: true };
  if (place.kind !== "worker" && ignoredBy(place, real)) return { editable: true };
  return { editable: false, kind: place.kind, why: place.why };
}

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostUnread } from "./host.ts";
import { isAbsent, readLaneConfig, type LaneConfig } from "./lane-config.ts";
import { remainingMs } from "./maintenance-budget.ts";

export interface LaneHome {
  readonly lane: string;
  readonly home: string;
  readonly config: LaneConfig;
}
export function gitWithin(cwd: string, args: readonly string[], deadline?: number): string {
  const timeout = remainingMs(deadline);
  if (timeout === 0) throw new HostUnread("maintenance deadline reached");
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(deadline === undefined ? {} : { timeout, killSignal: "SIGKILL" }),
    }).trim();
  } catch (error) {
    if (deadline !== undefined && Reflect.get(Object(error), "code") === "ETIMEDOUT")
      throw new HostUnread("maintenance deadline reached");
    throw error;
  }
}

export function codeRoot(deadline?: number): string {
  const set = process.env["FLEET_ROOT"];
  if (set !== undefined && set !== "") return set;
  const here = dirname(fileURLToPath(import.meta.url));
  return dirname(
    gitWithin(here, ["rev-parse", "--path-format=absolute", "--git-common-dir"], deadline),
  );
}

export const homeOf = (root: string, lane: string): string =>
  join(`${root}.worktrees`, `lane-${lane}`);

export function existingHome(root: string, lane: string): string {
  if (readLaneConfig(root)?.lane === lane) return root;
  const home = homeOf(root, lane);
  if (readLaneConfig(home)?.lane !== lane) throw new Error(`no lane ${lane} on this host`);
  return home;
}

export interface UnreadLane {
  readonly lane: string;
  readonly message: string;
}

type Scanned =
  | {
      readonly name: string;
      readonly lane: string;
      readonly home: string;
      readonly config: LaneConfig;
    }
  | { readonly name: string; readonly lane: string; readonly error: unknown };

function scanHomes(root: string): Scanned[] {
  const dir = `${root}.worktrees`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if (isAbsent(dir, error)) return [];
    throw error;
  }
  const scanned = entries
    .filter((name) => name.startsWith("lane-"))
    .sort()
    .flatMap((name): Scanned[] => {
      const home = join(dir, name);
      try {
        const config = readLaneConfig(home);
        return config === undefined ? [] : [{ name, lane: config.lane, home, config }];
      } catch (error) {
        const suffix = name.slice("lane-".length);
        return [{ name, lane: suffix.trim() === "" ? home : suffix, error }];
      }
    });
  return mergeSharedClaims(scanned);
}

function mergeSharedClaims(scanned: Scanned[]): Scanned[] {
  const owners = new Map<string, Scanned[]>();
  for (const found of scanned) owners.set(found.lane, [...(owners.get(found.lane) ?? []), found]);
  return scanned.flatMap((found): Scanned[] => {
    const same = owners.get(found.lane) ?? [];
    if (same.length === 1) return [found];
    if (same[0] !== found) return [];
    const homes = same.map((owner) => owner.name).join(", ");
    return [
      {
        name: found.name,
        lane: found.lane,
        error: new Error(`lane ${found.lane} is claimed by more than one home (${homes})`),
      },
    ];
  });
}

export interface Discovery {
  readonly homes: LaneHome[];
  readonly unread: UnreadLane[];
  readonly confirm?: (home: LaneHome) => void;
}

export function discoverLanes(root: string): Discovery {
  const homes: LaneHome[] = [];
  const unread: UnreadLane[] = [];
  for (const found of scanHomes(root)) {
    if ("error" in found) {
      const { error } = found;
      unread.push({
        lane: found.lane,
        message: error instanceof Error ? error.message : String(error),
      });
    } else homes.push({ lane: found.lane, home: found.home, config: found.config });
  }
  return { homes, unread };
}

export const unreadFailure = (unread: readonly UnreadLane[]): string =>
  unread.map(({ lane, message }) => `lane ${lane} could not be read: ${message}`).join("\n");

export function laneHomes(root: string): LaneHome[] {
  return scanHomes(root).map((found) => {
    if ("error" in found) throw found.error;
    return { lane: found.lane, home: found.home, config: found.config };
  });
}

export function laneClaimsRaced(
  root: string,
  captured: readonly LaneHome[],
  alsoKnown: readonly UnreadLane[] = [],
): { changed: Map<string, string>; added: UnreadLane[] } {
  const changed = new Map<string, string>();
  let now: Discovery;
  try {
    now = discoverLanes(root);
  } catch {
    for (const { lane } of captured)
      changed.set(lane, `${lane} claim could not be read again after it was checked`);
    return { changed, added: [] };
  }
  for (const info of captured) {
    const same = now.homes.find((each) => each.lane === info.lane);
    if (same?.home !== info.home || JSON.stringify(same.config) !== JSON.stringify(info.config))
      changed.set(info.lane, `${info.lane} claim changed or became ambiguous after it was checked`);
  }
  const known = new Set([...captured, ...alsoKnown].map(({ lane }) => lane));
  const added = [
    ...now.homes.map(({ lane }) => ({
      lane,
      message: `lane ${lane} appeared while it was being read`,
    })),
    ...now.unread,
  ].filter(({ lane }) => !known.has(lane));
  return { changed, added };
}

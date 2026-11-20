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
  | { readonly name: string; readonly home: string; readonly config: LaneConfig }
  | { readonly name: string; readonly home: string; readonly error: unknown };

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
        return config === undefined ? [] : [{ name, home, config }];
      } catch (error) {
        return [{ name, home, error }];
      }
    });
  return rejectSharedIdentities(scanned);
}

const identityOf = (found: Scanned): string =>
  "error" in found ? found.name.slice("lane-".length) : found.config.lane;

function rejectSharedIdentities(scanned: Scanned[]): Scanned[] {
  let current = scanned;
  for (;;) {
    const claims = new Map<string, Scanned[]>();
    for (const found of current)
      claims.set(identityOf(found), [...(claims.get(identityOf(found)) ?? []), found]);
    const shared = [...claims.entries()].filter(([, owners]) => owners.length > 1);
    if (shared.length === 0) return current;
    const rejected = new Set(
      shared.flatMap(([, owners]) => owners.filter((owner) => !("error" in owner))),
    );
    current = current.map((found) => {
      if (!rejected.has(found)) return found;
      const lane = identityOf(found);
      const homes = (claims.get(lane) ?? []).map((owner) => owner.name).join(", ");
      return {
        name: found.name,
        home: found.home,
        error: new Error(`lane ${lane} is claimed by more than one home (${homes})`),
      };
    });
  }
}

export function discoverLanes(root: string): { homes: LaneHome[]; unread: UnreadLane[] } {
  const homes: LaneHome[] = [];
  const unread: UnreadLane[] = [];
  for (const found of scanHomes(root)) {
    if ("error" in found) {
      const { error } = found;
      unread.push({
        lane: found.name.slice("lane-".length),
        message: error instanceof Error ? error.message : String(error),
      });
    } else homes.push({ lane: found.config.lane, home: found.home, config: found.config });
  }
  return { homes, unread };
}

export const unreadFailure = (unread: readonly UnreadLane[]): string =>
  unread.map(({ lane, message }) => `lane ${lane} could not be read: ${message}`).join("\n");

export function laneHomes(root: string): LaneHome[] {
  return scanHomes(root).map((found) => {
    if ("error" in found) throw found.error;
    return { lane: found.config.lane, home: found.home, config: found.config };
  });
}

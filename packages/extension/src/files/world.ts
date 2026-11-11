import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, OPS, type OpResult } from "@fleet/protocol";
import { callCardd } from "../cardd-call.ts";
import { codeRoot } from "../homes.ts";
import { ownHostName, ownsHostName } from "../host.ts";
import { exportHosts, LANE_FILE, readLaneConfig, type LaneConfig } from "../lane-config.ts";

export interface LocalClone {
  readonly project: string;
  readonly path: string;
  readonly base: string;
  readonly delivery: string;
}

export interface World {
  readonly root: string;
  readonly home: string;
  readonly lane: LaneConfig;
  readonly host: string;
  readonly clones: readonly LocalClone[];
  readonly projectsKnown: boolean;
}

export const PROJECTS_UNAVAILABLE =
  "cardd cannot be reached and no earlier project list is saved, so this host's project clones are not known";

type Projects = OpResult<"projects">;

function homeFrom(start: string): string {
  const named = process.env["FLEET_FILES_HOME"];
  if (named !== undefined && named !== "") return named;
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, LANE_FILE))) return dir;
    if (dirname(dir) === dir) throw new Error("fleet files: not inside a lane home");
  }
}

const projectsCache = (home: string): string => join(home, "state", "files", "projects.json");

function cached(home: string): Projects | undefined {
  try {
    return check(OPS.projects.result, JSON.parse(readFileSync(projectsCache(home), "utf8")));
  } catch {
    return undefined;
  }
}

async function projectsOf(home: string, lane: LaneConfig): Promise<Projects | undefined> {
  try {
    const projects = await callCardd(lane, "projects", {});
    mkdirSync(dirname(projectsCache(home)), { recursive: true });
    writeFileSync(projectsCache(home), JSON.stringify(projects));
    return projects;
  } catch {
    return cached(home);
  }
}

const clonesHere = (projects: Projects): LocalClone[] =>
  projects.flatMap(({ name, base, delivery, clones }) =>
    clones
      .filter((clone) => ownsHostName(clone.host))
      .map(({ path }) => ({ project: name, path, base, delivery })),
  );

export async function loadWorld(): Promise<World> {
  const home = homeFrom(process.cwd());
  const lane = readLaneConfig(home);
  if (lane === undefined) throw new Error(`fleet files: ${home} is not a lane home`);
  exportHosts(lane);
  const projects = await projectsOf(home, lane);
  return {
    root: codeRoot(),
    home,
    lane,
    host: ownHostName(),
    clones: clonesHere(projects ?? []),
    projectsKnown: projects !== undefined,
  };
}

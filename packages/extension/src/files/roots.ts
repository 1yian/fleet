import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { callCardd } from "../cardd-call.ts";
import { hostDir } from "../scratch.ts";
import { filesSettings } from "../lane-config.ts";
import { skillFolders } from "./places.ts";
import { scratchPath, workshopOf } from "./scratch-tree.ts";
import type { World } from "./world.ts";

export interface Root {
  readonly name: string;
  readonly path: string;
}

const WORKER_FOLDER = /^c-(\d+)-a\d+$/;

async function cardsOfLane(world: World): Promise<Set<number>> {
  try {
    const board = await callCardd(world.lane, "board", {});
    return new Set(board.filter((card) => card.lane === world.lane.lane).map((card) => card.id));
  } catch {
    return new Set();
  }
}

function workers(world: World, cards: ReadonlySet<number>): Root[] {
  return world.clones.flatMap(({ path, project }) => {
    const folder = `${path}.worktrees`;
    if (!existsSync(folder)) return [];
    return readdirSync(folder)
      .filter((name) => cards.has(Number(WORKER_FOLDER.exec(name)?.[1])))
      .map((name) => ({ name: `worker ${project} ${name}`, path: join(folder, name) }));
  });
}

function evidence(cards: ReadonlySet<number>): Root[] {
  return [...cards].flatMap((card) => [
    { name: `evidence c-${String(card)}`, path: join(hostDir(), "scratch", `c-${String(card)}`) },
    { name: `evidence c-${String(card)} (tmp)`, path: `/tmp/fleet-c-${String(card)}` },
  ]);
}

function skills(world: World): Root[] {
  const [agents = "", piAgent = ""] = skillFolders();
  const workshop = workshopOf(world);
  return [
    ...(workshop === undefined
      ? []
      : [
          { name: "skills scratch", path: workshop.skills },
          { name: "skills ystack", path: workshop.clone.path },
        ]),
    { name: "skills released", path: agents },
    { name: "skills user", path: piAgent },
    { name: "skills lane", path: join(world.home, "data", "skills") },
    { name: "skills home", path: join(world.home, ".pi", "skills") },
  ];
}

export async function rootsOf(world: World): Promise<Root[]> {
  const { home } = world;
  const cards = await cardsOfLane(world);
  const all: Root[] = [
    { name: "home", path: home },
    { name: "data", path: join(home, "data") },
    { name: "config", path: join(home, "config") },
    { name: "state", path: join(home, "state") },
    { name: "reports", path: join(home, "data", "reports") },
    ...world.clones.map(({ project, path }) => ({ name: `clone ${project}`, path })),
    ...world.clones.map((clone) => ({
      name: `scratch ${clone.project}`,
      path: scratchPath(clone),
    })),
    ...workers(world, cards),
    ...skills(world),
    ...evidence(cards),
    ...filesSettings(world.lane).roots.map((path) => ({ name: `extra ${path}`, path })),
  ];
  return all.filter((root) => existsSync(root.path));
}

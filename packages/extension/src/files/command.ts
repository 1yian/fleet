import { editInScratch, pushScratch, resetScratch, scratchLines } from "./scratch-tree.ts";
import { createPath, renamePath } from "./mutate.ts";
import { refusals } from "./places.ts";
import { openFile } from "./editor.ts";
import { rootsOf } from "./roots.ts";
import { reload, show, type Target } from "./show.ts";
import { skillsTable } from "./skills.ts";
import { goto, pick } from "./navigate.ts";
import { launchExplorer } from "./yazi.ts";
import { loadWorld, type World } from "./world.ts";

type Handler = (world: World, args: readonly string[]) => Promise<number> | number;

const lines = (text: readonly string[]): number => {
  for (const line of text) console.log(line);
  return 0;
};

const needs = (args: readonly string[], what: string): string => {
  const [first] = args;
  if (first === undefined) throw new Error(`fleet files: ${what}`);
  return first;
};

async function roots(world: World, args: readonly string[]): Promise<number> {
  const all = await rootsOf(world);
  const [flag, name] = args;
  if (flag === "--json") return lines([JSON.stringify(all)]);
  const picked =
    flag === "--first" ? all.find((root) => root.name.startsWith(name ?? "")) : undefined;
  if (flag === "--first") return picked === undefined ? 1 : lines([picked.path]);
  return lines(all.map((root) => `${root.name}\t${root.path}`));
}

function check(world: World, args: readonly string[]): number {
  const refused = refusals(world, args);
  for (const line of refused) console.error(line);
  return refused.length === 0 ? 0 : 1;
}

function scratch(world: World, args: readonly string[]): number {
  const [verb, project] = args;
  if (verb === undefined) return lines(scratchLines(world));
  if (verb !== "reset") throw new Error("fleet files scratch [reset [project]]");
  return lines(resetScratch(world, project));
}

function targetOf(args: readonly string[]): Target {
  const [target] = args;
  if (target !== "lane" && target !== "main") throw new Error("fleet files show|reload lane|main");
  return target;
}

function shown(world: World, args: readonly string[]): Promise<number> {
  const [, path, flag, lines] = args;
  if (path === undefined) throw new Error("fleet files show lane|main <path> [--lines 12-20]");
  return show(world, targetOf(args), path, flag === "--lines" ? lines : undefined);
}

const HANDLERS: Record<string, Handler> = {
  roots,
  check,
  rename: (world, args) => {
    renamePath(
      world,
      needs(args, "rename needs a path"),
      needs(args.slice(1), "rename needs a new path"),
    );
    return 0;
  },
  create: (world, args) => {
    createPath(world, needs(args, "create needs a path"));
    return 0;
  },
  open: (world, args) => openFile(world, needs(args, "open needs a path")),
  edit: (world, args) => editInScratch(world, needs(args, "edit needs a path")),
  scratch,
  push: (world, args) => lines([pushScratch(world, args.at(0) ?? process.cwd())]),
  show: shown,
  reload: (world, args) => reload(world, targetOf(args)),
  skills: (world) => lines(skillsTable(world)),
  goto: (world, args) => goto(world, needs(args, "goto needs a folder name")),
  pick: (world, args) => pick(world, needs(args, "pick needs clone or worktree")),
};

export async function runFiles(args: readonly string[]): Promise<number> {
  const [verb, ...rest] = args;
  try {
    const world = await loadWorld();
    if (verb === undefined) return launchExplorer(world);
    const handler = HANDLERS[verb];
    if (handler === undefined) throw new Error(`fleet files: unknown command ${verb}`);
    return await handler(world, rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

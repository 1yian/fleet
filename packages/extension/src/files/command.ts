import { editInScratch, pushScratch, resetScratch, scratchLines } from "./scratch-tree.ts";
import { decide } from "./places.ts";
import { openFile } from "./editor.ts";
import { rootsOf } from "./roots.ts";
import { skillsTable } from "./skills.ts";
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
  const refused = args.flatMap((path) => {
    const decision = decide(world, path);
    return decision.editable ? [] : [`${path}: guarded, ${decision.why}`];
  });
  for (const line of refused) console.error(line);
  return refused.length === 0 ? 0 : 1;
}

function scratch(world: World, args: readonly string[]): number {
  const [verb, project] = args;
  if (verb === undefined) return lines(scratchLines(world));
  if (verb !== "reset") throw new Error("fleet files scratch [reset [project]]");
  return lines(resetScratch(world, project));
}

const HANDLERS: Record<string, Handler> = {
  roots,
  check,
  open: (world, args) => openFile(world, needs(args, "open needs a path")),
  edit: (world, args) => editInScratch(world, needs(args, "edit needs a path")),
  scratch,
  push: (world, args) => lines([pushScratch(world, args[0] ?? process.cwd())]),
  skills: (world) => lines(skillsTable(world)),
};

export async function runFiles(args: readonly string[]): Promise<number> {
  const [verb, ...rest] = args;
  try {
    const world = await loadWorld();
    const handler = verb === undefined ? undefined : HANDLERS[verb];
    if (handler === undefined) throw new Error(`fleet files: unknown command ${verb ?? ""}`);
    return await handler(world, rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

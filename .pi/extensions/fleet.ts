// Loads the fleet extensions in a lane home, and nothing anywhere else. A lane home is a folder
// with config/lane.json: this repo for main, a worktree of it for a second mate. A worker in a
// worktree of this repo has none, so it loads nothing from here and needs no installed packages.
// Dispatch gives workers the fleet extension with -e instead.
import { existsSync } from "node:fs";
import { join } from "node:path";

const SOURCES = ["index.ts", "calm/index.ts", "optchat.ts"];

export default async function fleetHome(pi: unknown): Promise<void> {
  if (!existsSync(join(process.cwd(), "config", "lane.json"))) return;
  for (const file of SOURCES) {
    const loaded: unknown = await import(
      new URL(`../../packages/extension/src/${file}`, import.meta.url).href
    );
    const factory: unknown =
      typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "default") : undefined;
    if (typeof factory !== "function") throw new Error(`${file} has no extension to load`);
    await Reflect.apply(factory, undefined, [pi]);
  }
}

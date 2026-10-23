import { existsSync } from "node:fs";
import { join } from "node:path";

const SOURCES = ["index.ts", "calm/index.ts", "transcript/index.ts", "optchat.ts", "cache-ttl.ts"];

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

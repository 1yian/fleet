import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOADER = new URL("../vendor/optchat/firstmate/loader.ts", import.meta.url);

export default async function optchat(pi: ExtensionAPI): Promise<void> {
  const home = process.cwd();
  if (!existsSync(join(home, "config", "optchat.json"))) return;
  const before = process.env["FM_HOME"];
  process.env["FM_HOME"] = home;
  try {
    const loaded: unknown = await import(LOADER.href);
    const factory: unknown =
      typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "default") : undefined;
    if (typeof factory !== "function")
      throw new Error(`${LOADER.pathname} has no extension to load`);
    await Reflect.apply(factory, undefined, [pi]);
  } finally {
    if (before === undefined) delete process.env["FM_HOME"];
    else process.env["FM_HOME"] = before;
  }
}

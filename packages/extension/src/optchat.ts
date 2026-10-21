// Conversation memory for every mate, the way Firstmate's homes have it (optchat). The memory
// loader is the user-level extension ~/.pi/agent/extensions/fm-optchat. It stays idle unless FM_HOME names
// the Pi's own folder, and Firstmate sets that with `optpi`. A fleet home has no launcher, so
// this extension gives the loader that answer: when the home has config/optchat.json, it loads
// the loader again with FM_HOME set to the home. Pi evaluates a module each time it is loaded,
// so the second load sees the variable. Without that file, or without the loader, this does nothing.
// The loader reads config/optchat.json, config/optchat/<package>, data/optchat, and state/ in the home.
// `fleet home memory <lane>` (memory.ts) writes them.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function optchat(pi: ExtensionAPI): Promise<void> {
  const home = process.cwd();
  if (!existsSync(join(home, "config", "optchat.json"))) return;
  const agent = process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
  const loader = join(agent, "extensions", "fm-optchat", "index.ts");
  if (!existsSync(loader)) {
    console.error(`Fleet optchat: ${loader} is missing, so conversation memory is off.`);
    return;
  }
  const before = process.env["FM_HOME"];
  process.env["FM_HOME"] = home;
  try {
    const loaded: unknown = await import(pathToFileURL(loader).href);
    const factory: unknown =
      typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "default") : undefined;
    if (typeof factory !== "function") throw new Error(`${loader} has no extension to load`);
    await Reflect.apply(factory, undefined, [pi]);
  } finally {
    if (before === undefined) delete process.env["FM_HOME"];
    else process.env["FM_HOME"] = before;
  }
}

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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import Value from "typebox/value";
import { CooldownFileSchema, TiersStateSchema } from "@fleet/protocol";

const COOLING = /(?:^|[(,]\s*)([^\s,()]+\/[^\s,()]+)(?: on [^\s:,()]+)?: cooling/g;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function stateDir(agentDir: string): string {
  const raw = readJson(process.env["PI_TIERS_CONFIG"] ?? join(agentDir, "tiers.json"));
  const dir = Value.Check(TiersStateSchema, raw) ? raw.stateDir : undefined;
  if (dir === undefined) return join(agentDir, "tiers");
  return dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : dir;
}

function activeCooldowns(dir: string, now: number): Map<string, number> {
  const until = new Map<string, number>();
  const folder = join(dir, "cooldowns");
  const names = existsSync(folder)
    ? readdirSync(folder).filter((name) => name.endsWith(".json"))
    : [];
  for (const name of names) {
    const parsed = readJson(join(folder, name));
    if (!Value.Check(CooldownFileSchema, parsed)) continue;
    for (const [key, entry] of Object.entries(parsed))
      if (entry.untilMs > now && Number.isFinite(entry.untilMs))
        until.set(key, Math.max(until.get(key) ?? 0, entry.untilMs));
  }
  return until;
}

export function routerResumeAt(error: string, now: number = Date.now()): number | undefined {
  const named = [...error.matchAll(COOLING)].map((found) => found[1] ?? "");
  if (named.length === 0) return undefined;
  const until = activeCooldowns(stateDir(getAgentDir()), now);
  const free = named.flatMap((candidate) => {
    const provider = candidate.slice(0, candidate.indexOf("/"));
    const blocking = [`account:${provider}`, `model:${candidate}`].flatMap((key) => {
      const at = until.get(key);
      return at === undefined ? [] : [at];
    });
    return blocking.length === 0 ? [] : [Math.max(...blocking)];
  });
  return free.length === 0 ? undefined : Math.ceil(Math.min(...free));
}

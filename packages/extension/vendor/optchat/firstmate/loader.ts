// Fleet's conversation memory for mates: OptChat, vendored in this folder, loaded for the home in
// FM_HOME (fleet's optchat.ts sets it). Configured in <home>/config/optchat.json:
// {"enabled":true,"memoryHome":"data/optchat","profile":"main","thinking":"low"}
// The fixed profile must already exist at memoryHome/profiles/profile with AGENTS.md
// (`fleet home memory <lane>` makes it). No earlier sessions are imported.
// The summary model is fixed by the fleet (src/compaction-model.ts): tier/compact, or a Vertex
// model for a session on Vertex. compactorProvider/compactorModel in the file are ignored.
// Activation receipts are private state/optchat-activation.json, current pid/session only.
// Long-result archives are retained profile-local at firstmate-results/ (0700/0600).
// Set enabled:false and restart to disable without deleting history or archives.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFirstmateOptChat, operationalTypes } from "./compat.ts";
import { compactionModelFor } from "../../../src/compaction-model.ts";
import optchat, { promptFor } from "../src/index.ts";
import * as profiles from "../src/profiles.ts";
import * as prompts from "../src/prompts.ts";
import * as memory from "../src/memory.ts";
import * as transcript from "../src/transcript.ts";

interface Config {
  enabled: true;
  memoryHome: string;
  profile: string;
  compactorModel?: string;
  compactorProvider?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}
type ProfileSettings = ReturnType<typeof profiles.loadConfig>;
const VENDORED = "pi-optchat@0.9.0+fleet";
// Explicit Firstmate identity is required at user scope. Unlike the old project
// loader, the extension's own source directory is not a Firstmate home.
const homeInput = process.env.FM_HOME || process.env.FM_ROOT_OVERRIDE;
const home = homeInput ? resolve(homeInput) : undefined;
function readConfig(home: string): Config | undefined {
  const file = resolve(home, "config/optchat.json");
  if (!existsSync(file)) return;
  const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (value.enabled === false || value.enabled === undefined) return;
  if (value.enabled !== true || typeof value.memoryHome !== "string" || !value.memoryHome ||
      typeof value.profile !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.profile) ||
      (value.compactorModel !== undefined && (typeof value.compactorModel !== "string" || !value.compactorModel)) ||
      (value.compactorProvider !== undefined && (typeof value.compactorProvider !== "string" || !value.compactorProvider)) ||
      (value.thinking !== undefined && (typeof value.thinking !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh"].includes(value.thinking)))) {
    throw new Error("Invalid supervisor conversation-memory configuration in config/optchat.json");
  }
  return { enabled: true, memoryHome: value.memoryHome, profile: value.profile,
    compactorModel: value.compactorModel as string | undefined, compactorProvider: value.compactorProvider as string | undefined,
    thinking: value.thinking as Config["thinking"] };
}

export default async function firstmateOptChat(pi: ExtensionAPI): Promise<void> {
  // Ship/scout launches have this marker. Secondmates deliberately do not.
  // The cwd check also excludes project workers and a supervision resource loader elsewhere.
  if (process.env.FM_TASK_ID || !home || !existsSync(home) || realpathSync(process.cwd()) !== realpathSync(home)) return;
  const config = readConfig(home);
  if (!config) return;
  const receiptPath = resolve(home, "state/optchat-activation.json");
  const memoryHome = resolve(home, config.memoryHome);
  const profileDir = resolve(memoryHome, "profiles", config.profile);
  if (!existsSync(resolve(profileDir, "AGENTS.md"))) throw new Error(`Install the ${config.profile} conversation-memory profile before activation`);
  process.env.OPTCHAT_HOME = memoryHome;
  let compactor: ProfileSettings["compactor"] | undefined;
  let activatedAt: string | undefined;
  const receipt = (ctx: ExtensionContext, phase: "loaded" | "active") => {
    ctx.ui.setStatus("firstmate-memory", `${phase === "active" ? "Recall" : "Memory profile"}: ${config.profile}`);
    if (phase === "active" && activatedAt) return;
    if (phase === "active") activatedAt = new Date().toISOString();
    mkdirSync(dirname(receiptPath), { recursive: true });
    const temporary = `${receiptPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({
      phase, profile: config.profile, memoryHome, package: VENDORED,
      sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
      pid: process.pid, recordedAt: new Date().toISOString(), activatedAt, compactor,
    }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, receiptPath);
  };
  const prepare = (ctx: ExtensionContext) => {
    const binding = ctx.sessionManager.getEntries().slice().reverse().find(entry => entry.type === "custom" && entry.customType === "optchat.profile");
    if (binding?.type === "custom") {
      const data = binding.data as { name?: unknown };
      if (data?.name !== config.profile) throw new Error("This session belongs to another memory profile; preserve it and select the intended supervisor session");
    } else pi.appendEntry("optchat.profile", { name: config.profile });
    if (!ctx.model) throw new Error("Select the supervisor model before initializing conversation memory");
    if (ctx.model.provider === "codex-native") throw new Error("Native Codex thread reuse is not supported for conversation compression; use an ordinary Pi provider before enabling memory");
    // Summaries are many small calls: they go to the fleet's compactor, never to the mate's own model.
    const wanted = compactionModelFor(ctx.model);
    const own = { provider: ctx.model.provider, model: ctx.model.id };
    const fixed = ctx.modelRegistry.find(wanted.provider, wanted.id) ? { provider: wanted.provider, model: wanted.id } : own;
    compactor = { ...fixed, thinking: config.thinking || "low" };
    if (!ctx.modelRegistry.find(compactor.provider, compactor.model)) throw new Error(`Conversation-memory model ${compactor.provider}/${compactor.model} is not supported by this supervisor`);
    const previous = profiles.loadConfig(profileDir);
    // Resolve against this supervisor's own registry/account, never OptChat's first-party defaults.
    profiles.saveConfig(profileDir, { ...previous, compactor,
      subagent: { provider: ctx.model.provider, model: ctx.model.id, thinking: "off" } });
    activatedAt = undefined;
  };
  const integration = withFirstmateOptChat(pi, {
    profile: config.profile,
    instructionSection: () => `${profiles.instructions(profileDir)}\n\n${prompts.IMPORT_GUIDANCE}`,
    textContent: transcript.textContent,
    memoryPrompt: () => promptFor(`${prompts.MASTER}\n\n${prompts.VIEW_DOC}`, profiles.loadConfig(profileDir)),
    memorySearch: () => profiles.loadConfig(profileDir).memorySearch === true,
    resultDirectory: resolve(profileDir, "firstmate-results"),
    toolTextLimit: memory.CAP,
    prepare,
    receipt,
  });
  await optchat(integration, { connectedWindows: false, transientCustomTypes: operationalTypes });
  pi.registerCommand("firstmate-memory", {
    description: "Show this supervisor's conversation-memory profile and activation receipt",
    handler: async (_args, ctx) => {
      if (!existsSync(receiptPath)) { ctx.ui.notify("No conversation-memory activation receipt yet.", "info"); return; }
      const saved = JSON.parse(readFileSync(receiptPath, "utf8")) as { pid: number; sessionId: string };
      const current = saved.pid === process.pid && saved.sessionId === ctx.sessionManager.getSessionId();
      ctx.ui.notify(current ? JSON.stringify(saved, null, 2) : "The receipt belongs to an earlier process/session, not this supervisor.", "info");
    },
  });
}

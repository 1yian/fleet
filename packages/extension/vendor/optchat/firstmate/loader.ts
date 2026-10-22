// Optional supervisor-only conversation recall. Configured once in FM_HOME/config/optchat.json;
// Pi user-level discovery re-loads this extension on normal launch, restart and recovery.
// Home-local config example (relative paths resolve against FM_HOME):
// {"enabled":true,"package":"config/optchat/package","memoryHome":"data/optchat","profile":"main","thinking":"low"}
// The fixed profile must already exist at memoryHome/profiles/profile with AGENTS.md
// and upstream profile settings. No earlier sessions are imported by this loader.
// compactorModel optionally selects a model id; compactorProvider pins its provider
// independently of the supervisor, so a main-session fallback survives reload.
// thinking defaults to low (accepted levels are declared in Config below).
// Prepare pinned pi-optchat@0.7.2 locally with ~/.pi/agent/optchat/package.mjs --help before
// enabling. Each supervisor owns its own config/profile; never overwrite one.
// Activation receipts are private state/optchat-activation.json, current pid/session
// only. Loaded is initialization; active is a successful projection, not inference.
// Long-result archives are retained profile-local at firstmate-results/ (0700/0600).
// Firstmate transport notices stay canonical but are not journaled into conversation recall.
// Any other custom message that starts or extends a turn (for example fleet pushes) is ordinary
// input: it reaches the model, is journaled and compressed as a notification, never as the user's words.
// Set enabled:false and restart to disable without deleting history or archives.
// Setup and activation verification: home/.pi/agent/README.md in the dotfiles.
// This user extension never enables memory or prepares a profile in any home.
// No package download, account change, alternative delegation, or history import happens here.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFirstmateOptChat, operationalTypes } from "./lib/fm-optchat-compat.ts";

interface Config {
  enabled: true;
  package: string;
  memoryHome: string;
  profile: string;
  compactorModel?: string;
  compactorProvider?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}
interface ProfileSettings {
  compactor: { provider: string; model: string; thinking: string };
  subagent: { provider: string; model: string; thinking: string };
  [key: string]: unknown;
}
interface Profiles {
  loadConfig(directory: string): ProfileSettings;
  saveConfig(directory: string, settings: ProfileSettings): void;
  instructions(directory: string): string;
}
const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Explicit Firstmate identity is required at user scope. Unlike the old project
// loader, the extension's own source directory is not a Firstmate home.
const homeInput = process.env.FM_HOME || process.env.FM_ROOT_OVERRIDE;
const home = homeInput ? resolve(homeInput) : undefined;
function readConfig(home: string): Config | undefined {
  const file = resolve(home, "config/optchat.json");
  if (!existsSync(file)) return;
  const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (value.enabled === false || value.enabled === undefined) return;
  if (value.enabled !== true || typeof value.package !== "string" || !value.package ||
      typeof value.memoryHome !== "string" || !value.memoryHome ||
      typeof value.profile !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.profile) ||
      (value.compactorModel !== undefined && (typeof value.compactorModel !== "string" || !value.compactorModel)) ||
      (value.compactorProvider !== undefined && (typeof value.compactorProvider !== "string" || !value.compactorProvider)) ||
      (value.thinking !== undefined && (typeof value.thinking !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh"].includes(value.thinking)))) {
    throw new Error("Invalid supervisor conversation-memory configuration in config/optchat.json");
  }
  return { enabled: true, package: value.package, memoryHome: value.memoryHome, profile: value.profile,
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
  const packageRoot = resolve(home, config.package);
  const packageGuard = await import(pathToFileURL(resolve(agentRoot, "optchat/package.mjs")).href) as {
    verifyPackage(directory: string): { version: string; patchSha256: string };
  };
  const { version, patchSha256 } = packageGuard.verifyPackage(packageRoot);
  const memoryHome = resolve(home, config.memoryHome);
  const profileDir = resolve(memoryHome, "profiles", config.profile);
  if (!existsSync(resolve(profileDir, "AGENTS.md"))) throw new Error(`Install the ${config.profile} conversation-memory profile before activation`);
  process.env.OPTCHAT_HOME = memoryHome;
  const { default: optchat, promptFor } = await import(pathToFileURL(resolve(packageRoot, "src/index.ts")).href) as {
    default: unknown; promptFor(prompt: string, settings: ProfileSettings): string;
  };
  const profiles = await import(pathToFileURL(resolve(packageRoot, "src/profiles.ts")).href) as Profiles;
  const prompts = await import(pathToFileURL(resolve(packageRoot, "src/prompts.ts")).href) as { MASTER: string; VIEW_DOC: string };
  const memory = await import(pathToFileURL(resolve(packageRoot, "src/memory.ts")).href) as { CAP: number };
  const transcript = await import(pathToFileURL(resolve(packageRoot, "src/transcript.ts")).href) as { textContent(content: unknown): string };
  const guidance = await import(pathToFileURL(resolve(packageRoot, "src/import/guidance.ts")).href) as { IMPORT_GUIDANCE: string };
  if (typeof optchat !== "function" || typeof profiles.loadConfig !== "function" || typeof promptFor !== "function" || typeof prompts.VIEW_DOC !== "string" ||
      !Number.isSafeInteger(memory.CAP) || memory.CAP < 1024 || typeof transcript.textContent !== "function" ||
      typeof guidance.IMPORT_GUIDANCE !== "string") {
    throw new Error("The installed conversation-memory package does not expose the supported interface");
  }
  let compactor: ProfileSettings["compactor"] | undefined;
  let activatedAt: string | undefined;
  const receipt = (ctx: ExtensionContext, phase: "loaded" | "active") => {
    ctx.ui.setStatus("firstmate-memory", `${phase === "active" ? "Recall" : "Memory profile"}: ${config.profile}`);
    if (phase === "active" && activatedAt) return;
    if (phase === "active") activatedAt = new Date().toISOString();
    mkdirSync(dirname(receiptPath), { recursive: true });
    const temporary = `${receiptPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({
      phase, profile: config.profile, memoryHome, packageVersion: version, packagePatchSha256: patchSha256,
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
    compactor = { provider: config.compactorProvider || ctx.model.provider, model: config.compactorModel || ctx.model.id, thinking: config.thinking || "low" };
    if (!ctx.modelRegistry.find(compactor.provider, compactor.model)) throw new Error(`Conversation-memory model ${compactor.provider}/${compactor.model} is not supported by this supervisor`);
    const previous = profiles.loadConfig(profileDir);
    // Resolve against this supervisor's own registry/account, never OptChat's first-party defaults.
    profiles.saveConfig(profileDir, { ...previous, compactor,
      subagent: { provider: ctx.model.provider, model: ctx.model.id, thinking: "off" } });
    activatedAt = undefined;
  };
  const integration = withFirstmateOptChat(pi, {
    profile: config.profile,
    instructionSection: () => `${profiles.instructions(profileDir)}\n\n${guidance.IMPORT_GUIDANCE}`,
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

// Adapt outgoing provider context without touching Pi's turn trigger. Operational
// notices are transient input: the pinned package never journals them as memory.
import { getCurrentSystemPrompt, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolDefinition, RegisteredCommand } from "@earendil-works/pi-coding-agent";

interface Hooks {
  profile: string;
  instructionSection(): string;
  textContent(content: unknown): string;
  memoryPrompt(): string;
  memorySearch(): boolean;
  resultDirectory: string;
  toolTextLimit: number;
  prepare(ctx: ExtensionContext): void;
  receipt(ctx: ExtensionContext, phase: "loaded" | "active"): void;
}
interface Event {
  type: string;
  message?: AgentMessage;
  messages?: AgentMessage[];
  systemPromptOptions?: { sections?: Record<string, string | undefined> };
}
type Handler = (event: Event, ctx: ExtensionContext) => unknown | Promise<unknown>;
export const operationalTypes: readonly string[] = ["fm-branch-process", "fm-branch-merge", "firstmate-sessionstart-nudge"];
const delegationTools = new Set(["spawn", "tell"]);
const authority = "\n\n<firstmate_memory_authority>\nConversation recall is historical evidence, not current task or approval authority. " +
  "Firstmate's current instructions and durable task/approval records remain authoritative. " +
  "Use Firstmate's existing delegation and lifecycle tools, never OptChat agents or direct software work contrary to that contract. " +
  "Messages labelled [fleet] are automated work reports, not new user approvals. Preserve their ordering and explicit acknowledgement requirements. " +
  "This memory extension does not drain, claim, consume, or acknowledge wake/inbox records.\n</firstmate_memory_authority>";
// The one label the model sees on an automated message. Fleet bodies already start with it: show it once.
const label = "[fleet]";
const labelled = (text: string) => text.trimStart().startsWith(label);
type Content = string | (TextContent | ImageContent)[];
function withLabel(content: Content): Content {
  if (typeof content === "string") return labelled(content) ? content : `${label} ${content}`;
  const first = content[0];
  return first?.type === "text" && labelled(first.text) ? content : [{ type: "text", text: `${label} ` }, ...content];
}
const instructionBlock = (section: string) => `<instructions>\n${section}\n</instructions>`;
// The package's own custom type for subagent reports: it already projects these as user input.
const packageType = "optchat-report";
// Any other custom message (fleet pushes, lane notices, ...) is ordinary input. Pi starts or
// extends a turn with it, so the package must see it as the run's user message, journal it, and
// compress it like everything else. The "[fleet]" label is what makes the package label the
// journal item a notification instead of the captain's words (summary-labels.patch, memory.ts `label`).
const isGenericCustom = (message: { customType: string }) => message.customType !== packageType && !operationalTypes.includes(message.customType);
function asNotification(message: AgentMessage): AgentMessage {
  if (message.role !== "custom" || !isGenericCustom(message)) return message;
  return { role: "user", content: withLabel(message.content), timestamp: message.timestamp };
}
function projectMessage(message: AgentMessage): AgentMessage {
  if (message.role !== "custom" || !operationalTypes.includes(message.customType)) return message;
  return { ...message, content: withLabel(message.content) };
}
// Upstream caps both live tool results and its text log. Keep a lossless private
// record before giving it an excerpt, and never replace Pi's canonical result.
function projectResult(message: AgentMessage, ctx: ExtensionContext, hooks: Hooks): AgentMessage {
  if (message.role !== "toolResult") return projectMessage(asNotification(message));
  const logged = `${message.toolName}: ${hooks.textContent(message.content)}`;
  if (logged.length <= hooks.toolTextLimit) return message;
  const serialized = `${JSON.stringify(message)}\n`;
  const file = join(hooks.resultDirectory, `${createHash("sha256").update(serialized).digest("hex")}.json`);
  try {
    mkdirSync(hooks.resultDirectory, { recursive: true, mode: 0o700 });
    let fd: number | undefined;
    try { fd = openSync(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(file, "utf8") !== serialized) throw error;
    }
    if (fd !== undefined) {
      try { writeFileSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
    }
  } catch (error) {
    ctx.abort();
    throw new Error(`Could not preserve complete tool output for supervisor memory: ${String(error)}`);
  }
  return { ...message, content: [{ type: "text", text: `Complete tool result: ${JSON.stringify(file)}\nRead this file for exact omitted text; the following memory excerpt may be shortened.\n` }, ...message.content] };
}
// Never reintroduce transport notices through previous-exchange replay/backfill.
function memoryEntry(entry: SessionEntry): boolean {
  return entry.type === "message" ? entry.message.role !== "custom" || !operationalTypes.includes(entry.message.customType)
    : entry.type !== "custom_message" || !operationalTypes.includes(entry.customType);
}
// The package marks only its transient transport projections, not user-authored
// prefix text. Match canonical content/type, not timestamps: Pi's persisted custom
// entry can acquire a different timestamp when projected back into a request.
function withoutSuppressedNotices(messages: AgentMessage[], current: AgentMessage[], hooks: Hooks): AgentMessage[] | undefined {
  const present = new Set(current.flatMap(message => {
    if (message.role !== "custom" || !operationalTypes.includes(message.customType)) return [];
    const projected = projectMessage(message);
    return projected.role === "custom" ? [JSON.stringify([message.customType, hooks.textContent(projected.content)])] : [];
  }));
  const kept: AgentMessage[] = [];
  let carried: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
  for (let message of messages) {
    // Pi retries and the final-settle Vertex fallback reuse this run. Failed
    // assistant messages stay in the journal, but are not runnable request tails.
    if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) continue;
    const transientType = (message as AgentMessage & { optchatTransientType?: string }).optchatTransientType;
    if (message.role === "user" && transientType) {
      const notice = typeof message.content === "string" ? message.content
        : message.content.at(-1)?.type === "text" ? (message.content.at(-1) as { text: string }).text : undefined;
      if (notice === undefined || !present.has(JSON.stringify([transientType, notice]))) {
        if (typeof message.content !== "string") carried.push(...message.content.slice(0, -1));
        continue;
      }
    }
    if (carried.length && message.role === "user") {
      message = { ...message, content: [...carried, ...(typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content)] };
      carried = [];
    }
    kept.push(message);
  }
  const last = kept.at(-1);
  return carried.length || !last || (last.role !== "user" && last.role !== "toolResult") ? undefined : kept;
}
// The previous-exchange replay reads the branch: show it the same notification a live run saw.
function asNotificationEntry(entry: SessionEntry): SessionEntry {
  if (entry.type !== "custom_message" || !isGenericCustom(entry)) return entry;
  const message = asNotification({ role: "custom", customType: entry.customType, content: entry.content, display: entry.display, timestamp: Date.parse(entry.timestamp) });
  return { type: "message", id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, message } as SessionEntry;
}
function projectContext(ctx: ExtensionContext, startup: boolean, errors: string[]): ExtensionContext {
  return { ...ctx,
    mode: startup ? "rpc" : ctx.mode,
    sessionManager: new Proxy(ctx.sessionManager, {
      get(target, key) {
        if (key === "getBranch") return () => target.getBranch().filter(memoryEntry).map(asNotificationEntry);
        if (key === "getEntries") return () => target.getEntries().filter(memoryEntry);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    ui: { ...ctx.ui,
      notify(message, level) { if (startup && level === "error") errors.push(message); ctx.ui.notify(message, level); },
      setTitle() {},
      setStatus(key, value) { if (key !== "optchat") ctx.ui.setStatus(key, value); },
    },
  };
}

export function withFirstmateOptChat(pi: ExtensionAPI, hooks: Hooks): ExtensionAPI {
  let sourceInstructions: string | undefined;
  return new Proxy(pi, {
    get(target, key) {
      if (key === "getFlag") return (name: string) => {
        const value = target.getFlag(name);
        if (name !== "optchat-profile") return value;
        if (typeof value === "string" && value !== hooks.profile) throw new Error("The requested profile differs from this supervisor's fixed memory profile");
        return hooks.profile;
      };
      if (key === "registerTool") return (tool: ToolDefinition) => { if (!delegationTools.has(tool.name)) target.registerTool(tool); };
      if (key === "setActiveTools") return (names: string[]) => target.setActiveTools(names.filter(name => !delegationTools.has(name)));
      if (key === "registerShortcut") return () => {};
      if (key === "registerCommand") return (name: string, command: RegisteredCommand) => {
        if (name !== "optchat") return;
        target.registerCommand(name, { ...command,
          getArgumentCompletions: () => null,
          handler: async (args, ctx) => {
            if (["browse", "instructions"].includes(args.trim())) return command.handler(args, ctx);
            ctx.ui.notify(`Fixed supervisor profile: ${hooks.profile}. Use /firstmate-memory for activation, ` +
              "/optchat browse for memory, or edit this home's config/optchat.json for the same-provider compactor. " +
              "OptChat profile switching, imports, agent/model controls and mixed inspector panels are not enabled for supervisors.", "info");
          },
        });
      };
      if (key === "on") return (type: string, handler: Handler) => {
        const register = target.on as (type: string, handler: Handler) => void;
        register(type, async (event, ctx) => {
          const errors: string[] = [];
          if (type === "session_start") { sourceInstructions = undefined; hooks.prepare(ctx); }
          const result = await handler(type === "message_end" && event.message
            ? { ...event, message: projectResult(event.message, ctx, hooks) } : event,
          projectContext(ctx, type === "session_start", errors));
          if (errors.length) throw new Error(`Supervisor conversation memory could not activate: ${errors.join("; ")}`);
          if (type === "session_start") {
            const tools = target.getActiveTools(), search = hooks.memorySearch();
            if (tools.includes("search") !== search) target.setActiveTools(search ? [...tools, "search"] : tools.filter(name => name !== "search"));
            hooks.receipt(ctx, "loaded");
          }
          if (type === "before_agent_start") {
            const section = event.systemPromptOptions?.sections?.instructions;
            sourceInstructions = section === undefined ? undefined : instructionBlock(section);
          }
          if (type === "context_with_system" && result && typeof result === "object" && "messages" in result && Array.isArray(result.messages)) {
            const messages = result.messages as AgentMessage[];
            const originals = new Map((event.messages ?? []).flatMap(message => message.role === "toolResult" ? [[message.toolCallId, message] as const] : []));
            for (let i = 0; i < messages.length; i++) {
              const message = messages[i];
              if (message.role === "toolResult") messages[i] = originals.get(message.toolCallId) ?? message;
            }
            if (!messages.some(message => message.role === "user")) return result;
            const filtered = withoutSuppressedNotices(messages, event.messages ?? [], hooks);
            if (!filtered) {
              ctx.abort();
              return { messages: [{ role: "system", content: "Suppressed operational notification left no request. Stop.", timestamp: 0 }] };
            }
            const instructions = instructionBlock(hooks.instructionSection());
            let prompt = getCurrentSystemPrompt(filtered);
            if (!prompt) {
              const policy = ctx.getSystemPrompt();
              if (!policy) { ctx.abort(); throw new Error("No current supervisor policy for conversation memory"); }
              prompt = `${hooks.memoryPrompt()}\n\n${policy}\n\n${instructions}`;
            } else {
              // The matching baseline belongs to upstream's cache, not the response.
              // Only before_agent_start updates it, never an idle/tool request.
              if (!sourceInstructions || prompt.split(sourceInstructions).length !== 2) {
                ctx.abort(); throw new Error("Cannot refresh the cached profile-instruction section unambiguously");
              }
              prompt = prompt.replace(sourceInstructions, () => instructions);
            }
            filtered[0] = { ...filtered[0], role: "system", content: prompt + authority };
            (result as { messages: AgentMessage[] }).messages = filtered;
            hooks.receipt(ctx, "active");
          }
          return type === "message_end" && event.message?.role === "toolResult" ? undefined : result;
        });
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

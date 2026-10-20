// The fleet Pi extension. Dispatch starts each worker with --fleet-url,
// --fleet-token, and --fleet-role. FLEET_URL, FLEET_TOKEN, and FLEET_ROLE work
// too, for mates started by hand. Without a URL, a token, and a role of worker
// or mate, the extension does nothing.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleetEntryId, format, idsInSessionFile } from "./inbox.ts";
import { Jobs } from "./jobs.ts";
import { Link } from "./link.ts";
import { ROLE_PROMPTS } from "./prompts.ts";
import { registerMate } from "./mate.ts";
import { registerAuthority, registerQuestions } from "./questions.ts";
import { WorkerRun } from "./worker.ts";

interface Config {
  readonly url: string;
  readonly token: string;
  readonly role: "worker" | "mate";
}

function config(pi: ExtensionAPI): Config | undefined {
  const value = (flag: string, env: string): string | undefined => {
    const fromFlag = pi.getFlag(flag);
    return typeof fromFlag === "string" && fromFlag !== "" ? fromFlag : process.env[env];
  };
  const url = value("fleet-url", "FLEET_URL");
  const token = value("fleet-token", "FLEET_TOKEN");
  const role = value("fleet-role", "FLEET_ROLE");
  if (url === undefined || token === undefined || (role !== "worker" && role !== "mate"))
    return undefined;
  return { url, token, role };
}

function piArgs(): string[] {
  const parsed: unknown = JSON.parse(process.env["FLEET_PI_ARGS"] ?? "[]");
  return Array.isArray(parsed) ? parsed.filter((arg) => typeof arg === "string") : [];
}

function start(
  pi: ExtensionAPI,
  { url, token, role }: Config,
  sessionFile: string | undefined,
): void {
  const injected = new Set(idsInSessionFile(sessionFile));
  const link = new Link({
    url,
    token,
    inFile: () => idsInSessionFile(sessionFile),
    onConnect: () => {
      pi.events.emit("fleet:connected", {});
      worker?.flush();
      jobs?.sync().catch(() => undefined);
    },
    onPush: ({ entry, mode }) => {
      if (injected.has(entry.id)) return;
      injected.add(entry.id);
      pi.sendMessage(
        {
          customType: "fleet",
          content: format(entry),
          display: true,
          details: { entryId: entry.id },
        },
        { triggerTurn: true, deliverAs: mode },
      );
      // Other extensions, such as the calm UI, can follow what the fleet queued for this session.
      pi.events.emit("fleet:delivered", { entryId: entry.id, mode });
      if (entry.kind === "job-result") jobs?.finished(entry.fields["job"]);
      worker?.reset();
    },
  });
  const jobs = role === "worker" ? new Jobs(link) : undefined;
  jobs?.register(pi, { url, token });
  const worker = jobs === undefined ? undefined : new WorkerRun(link, jobs);
  worker?.register(pi);
  if (role === "mate") registerQuestions(pi, link, () => sessionFile);
  if (role === "mate") registerAuthority(pi, link, () => sessionFile);
  if (role === "mate") registerMate(pi, link, { url, piArgs: piArgs() });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${ROLE_PROMPTS[role]}`,
  }));
  pi.on("session_shutdown", () => {
    link.stop();
  });
  pi.on("message_end", (event) => {
    const id = fleetEntryId(event.message);
    if (id !== undefined) link.ack(id);
  });
  // Activity at each run and tool call keeps last_activity fresh for the stall check (spec section 12.2).
  const active = (): void => {
    link.activity("running");
  };
  pi.on("agent_start", active);
  pi.on("tool_execution_start", active);
  pi.on("tool_execution_end", active);
  pi.on("agent_settled", () => {
    link.activity(jobs?.waiting === true ? "waiting" : "idle");
  });
  link.start();
}

export default function fleet(pi: ExtensionAPI): void {
  pi.registerFlag("fleet-url", { type: "string", description: "The cardd websocket URL" });
  pi.registerFlag("fleet-token", { type: "string", description: "This session's cardd token" });
  pi.registerFlag("fleet-role", { type: "string", description: "worker or mate" });
  let started = false;
  pi.on("session_start", (_event, ctx) => {
    const found = config(pi);
    if (started || found === undefined) return;
    started = true;
    start(pi, found, ctx.sessionManager.getSessionFile());
  });
}

// The fleet Pi extension. Dispatch starts each worker with --fleet-url,
// --fleet-token, and --fleet-role (fleet-args.ts writes them). FLEET_URL, FLEET_TOKEN, and FLEET_ROLE work
// too. A Pi started in a lane home (the fleet repo for main, a worktree of it for a
// second mate) needs none of them: the home's config/lane.json makes it that lane's
// mate. Without either, the extension does nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleetEntryId, format, idsInSessionFile } from "./inbox.ts";
import { Jobs } from "./jobs.ts";
import { readLaneConfig, workerPiArgs } from "./lane-config.ts";
import { Link } from "./link.ts";
import { registerLanes } from "./lanes.ts";
import { ROLE_PROMPTS } from "./prompts.ts";
import { registerMate } from "./mate.ts";
import { registerQuestions } from "./questions.ts";
import { WorkerRun } from "./worker.ts";

interface Config {
  readonly url: string;
  readonly token: string;
  readonly role: "worker" | "mate";
  /** Set when the config came from the home's lane.json. */
  readonly lane?: string;
}

const EXTENSION = fileURLToPath(import.meta.url);
const HOME = (): string => process.cwd();

function config(pi: ExtensionAPI): Config | undefined {
  const value = (flag: string, env: string): string | undefined => {
    const fromFlag = pi.getFlag(flag);
    return typeof fromFlag === "string" && fromFlag !== "" ? fromFlag : process.env[env];
  };
  const url = value("fleet-url", "FLEET_URL");
  const token = value("fleet-token", "FLEET_TOKEN");
  const role = value("fleet-role", "FLEET_ROLE");
  if (url !== undefined && token !== undefined && (role === "worker" || role === "mate"))
    return { url, token, role };
  const lane = readLaneConfig(HOME());
  if (lane === undefined) return undefined;
  // What the lane's own commands and workers need, from the same file.
  process.env["FLEET_HOSTS"] ??= JSON.stringify(lane.hosts);
  process.env["FLEET_PI_ARGS"] ??= JSON.stringify(["-e", EXTENSION, ...workerPiArgs(lane)]);
  return { url: lane.url, token: lane.token, role: "mate", lane: lane.lane };
}

/** The lane's private charter, data/charter.md: its lane table, its projects, and where its records are. */
function charter(): string {
  try {
    const text = readFileSync(join(HOME(), "data", "charter.md"), "utf8").trim();
    return text === "" ? "" : `\n\n${text}`;
  } catch {
    return "";
  }
}

function piArgs(): string[] {
  const parsed: unknown = JSON.parse(process.env["FLEET_PI_ARGS"] ?? "[]");
  return Array.isArray(parsed) ? parsed.filter((arg) => typeof arg === "string") : [];
}

function start(
  pi: ExtensionAPI,
  { url, token, role, lane }: Config,
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
  // Main keeps the rest of the fleet running (docs/setup.md), and its board shows the lanes.
  const lanes = lane === "main" ? registerLanes(pi, HOME()) : undefined;
  if (role === "mate") registerQuestions(pi, link, () => sessionFile);
  if (role === "mate") registerMate(pi, link, { url, piArgs: piArgs() }, lanes);

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${ROLE_PROMPTS[role]}${role === "mate" ? charter() : ""}`,
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

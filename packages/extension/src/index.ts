import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBranch } from "./branch.ts";
import { applyCachePolicy, applyTierPolicy } from "./cache-policy.ts";
import { applyContextPolicy } from "./context-policy.ts";
import { refreshEveryCloneOnFirstConnect } from "./clones.ts";
import { Digest } from "./digest.ts";
import { format, idsInSessionFile } from "./inbox.ts";
import { registerIntake } from "./intake.ts";
import { Jobs } from "./jobs.ts";
import {
  DEFAULT_COSTS,
  readLaneConfig,
  workerPiArgs,
  type Costs,
  type LaneConfig,
} from "./lane-config.ts";
import { Link } from "./link.ts";
import { registerLanes } from "./lanes.ts";
import { registerPlan } from "./plan.ts";
import { ROLE_PROMPTS } from "./prompts.ts";
import { registerMate } from "./mate.ts";
import { registerQuestions } from "./questions.ts";
import { registerReview } from "./review.ts";
import { standingRules } from "./standing.ts";
import { registerStow } from "./stow.ts";
import { titleMate } from "./titles.ts";
import { registerUpdate } from "./updating.ts";
import { WorkerRun } from "./worker.ts";

interface Config {
  readonly url: string;
  readonly token: string;
  readonly role: "worker" | "mate";
  readonly lane?: string;
  readonly costs?: Costs;
}

const CONTEXT_CAP_FLAG = "fleet-context-cap";

const EXTENSION = fileURLToPath(import.meta.url);
const HOME = (): string => process.cwd();

function exportHosts(lane: LaneConfig): void {
  process.env["FLEET_HOSTS"] ??= JSON.stringify(lane.hosts);
  process.env["FLEET_HOST"] ??= lane.host ?? "";
  process.env["FLEET_ROOTS"] ??= JSON.stringify(lane.roots);
}

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
  exportHosts(lane);
  process.env["FLEET_PI_ARGS"] ??= JSON.stringify([
    "-e",
    EXTENSION,
    `--${CONTEXT_CAP_FLAG}=${String(lane.costs.workerContextCap)}`,
    ...workerPiArgs(lane),
  ]);
  return { url: lane.url, token: lane.token, role: "mate", lane: lane.lane, costs: lane.costs };
}

function charter(): string {
  try {
    const text = readFileSync(join(HOME(), "data", "charter.md"), "utf8").trim();
    return text === "" ? "" : `\n\n${text}`;
  } catch {
    return "";
  }
}

const mateContract = (): string => charter() + standingRules(HOME());

function piArgs(): string[] {
  const parsed: unknown = JSON.parse(process.env["FLEET_PI_ARGS"] ?? "[]");
  return Array.isArray(parsed) ? parsed.filter((arg) => typeof arg === "string") : [];
}

function contextCap(pi: ExtensionAPI): number {
  const flag = pi.getFlag(CONTEXT_CAP_FLAG);
  const value = typeof flag === "string" ? Number(flag) : Number.NaN;
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_COSTS.workerContextCap;
}

function start(
  pi: ExtensionAPI,
  { url, token, role, lane, costs }: Config,
  sessionFile: string | undefined,
): void {
  const digest = new Digest(pi, costs);
  const injected = new Set(idsInSessionFile(sessionFile));
  const injectedAgain = new Set<number>();
  let unreadable: string | undefined;
  const link = new Link({
    url,
    token,
    inFile: () => idsInSessionFile(sessionFile),
    onUnreadable: (error) => {
      if (unreadable === error) return;
      unreadable = error;
      pi.sendMessage(
        {
          customType: "fleet-link",
          content: `[fleet] link: cardd sent a message this session cannot read (${error}). It may run other code than this extension. The session keeps reconnecting.`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
    onConnect: () => {
      unreadable = undefined;
      pi.events.emit("fleet:connected", {});
      worker?.flush();
      jobs?.sync().catch(() => undefined);
    },
    onPush: ({ entry, name, mode, again = false }) => {
      const seen = again ? injectedAgain : injected;
      if (seen.has(entry.id)) return;
      seen.add(entry.id);
      const routine = digest.holds(entry, mode);
      pi.sendMessage(
        {
          customType: "fleet",
          content: format(entry, name, again),
          display: true,
          details: { entryId: entry.id },
        },
        routine ? { deliverAs: "nextTurn" } : { triggerTurn: true, deliverAs: mode },
      );
      if (routine) link.ack(entry.id);
      pi.events.emit("fleet:delivered", { entryId: entry.id, mode });
      if (entry.kind === "job-result" || entry.kind === "review-feedback")
        jobs?.finished(entry.fields["job"]);
      worker?.reset();
    },
  });
  const jobs = role === "worker" ? new Jobs(link, { url, token }) : undefined;
  jobs?.register(pi);
  if (jobs !== undefined) {
    registerReview(pi, jobs);
    registerBranch(pi, link);
  }
  const worker = jobs === undefined ? undefined : new WorkerRun(link, jobs);
  worker?.register(pi);
  const lanes = lane === "main" ? registerLanes(pi, HOME()) : undefined;
  if (role === "mate") {
    registerQuestions(pi, link, () => sessionFile);
    registerMate(pi, link, { url, piArgs: piArgs() }, lanes);
    registerStow(pi, HOME(), lane);
    registerPlan(pi, link);
  }
  if (lane === "main") {
    refreshEveryCloneOnFirstConnect(pi, link);
    registerUpdate(pi, HOME(), link);
  }

  applyCachePolicy(role, costs);
  applyTierPolicy(role);
  applyContextPolicy(role, contextCap(pi));
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${ROLE_PROMPTS[role]}${role === "mate" ? mateContract() : ""}`,
  }));
  pi.on("session_shutdown", () => {
    link.stop();
  });
  registerIntake(pi, link);
  digest.register();
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
  pi.registerFlag(CONTEXT_CAP_FLAG, {
    type: "string",
    description: "A worker's context window cap in tokens; 0 keeps the model's own",
  });
  let started = false;
  pi.on("session_start", (_event, ctx) => {
    const found = config(pi);
    if (started || found === undefined) return;
    started = true;
    start(pi, found, ctx.sessionManager.getSessionFile());
    if (found.lane !== undefined) titleMate(pi, found.lane).catch(() => undefined);
  });
}

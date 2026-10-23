import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Entry } from "@fleet/protocol";
import { registerBranch } from "./branch.ts";
import { registerGuard } from "./guard.ts";
import { applyCachePolicy } from "./cache-policy.ts";
import { applyCompactionBackoff } from "./compaction-backoff.ts";
import { applyCompactionPolicy } from "./compaction-policy.ts";
import { applyContextPolicy } from "./context-policy.ts";
import { refreshEveryCloneOnFirstConnect } from "./clones.ts";
import { Failures } from "./failure.ts";
import { format, idsInSessionFile } from "./inbox.ts";
import { closeMerged, isMergedReport } from "./auto-close.ts";
import { registerIntake } from "./intake.ts";
import { Jobs, registerDropJob } from "./jobs.ts";
import { readLaneConfig, workerPiArgs, type LaneConfig } from "./lane-config.ts";
import { Link, type Push } from "./link.ts";
import { registerLanes } from "./lanes.ts";
import { registerPlan } from "./plan.ts";
import { reportActivity } from "./progress.ts";
import { ROLE_PROMPTS } from "./prompts.ts";
import { MaintenanceQueue } from "./maintenance.ts";
import { registerMate } from "./mate.ts";
import { registerRestart } from "./restart.ts";
import { registerQuestions } from "./questions.ts";
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
}

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
  process.env["FLEET_PI_ARGS"] ??= JSON.stringify(["-e", EXTENSION, ...workerPiArgs(lane)]);
  return { url: lane.url, token: lane.token, role: "mate", lane: lane.lane };
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

function tellUnreadable(pi: ExtensionAPI, error: string): void {
  pi.sendMessage(
    {
      customType: "fleet-link",
      content: `[fleet] link: cardd sent a message this session cannot read (${error}). It may run other code than this extension. The session keeps reconnecting.`,
      display: true,
    },
    { triggerTurn: false },
  );
}

function workerTools(pi: ExtensionAPI, link: Link, cardd: { url: string; token: string }): Jobs {
  const jobs = new Jobs(link, cardd);
  jobs.register(pi);
  registerBranch(pi, link);
  return jobs;
}

function sendEntry(
  pi: ExtensionAPI,
  entry: Entry,
  mode: "steer" | "followUp",
  content: string,
): void {
  pi.sendMessage(
    { customType: "fleet", content, display: true, details: { entryId: entry.id } },
    { triggerTurn: entry.fields["compaction"] !== true, deliverAs: mode },
  );
}

function start(
  pi: ExtensionAPI,
  { url, token, role, lane }: Config,
  sessionFile: string | undefined,
  compact: () => void,
  ctx: ExtensionContext,
  extensionsReady: Promise<void>,
): void {
  const injected = new Set(idsInSessionFile(sessionFile));
  const injectedAgain = new Set<number>();
  pi.on("agent_settled", () => {
    injectedAgain.clear();
  });
  let unreadable: string | undefined;
  const maintenance: { queue?: MaintenanceQueue } = {};
  const link = new Link({
    url,
    token,
    inFile: () => idsInSessionFile(sessionFile),
    process: randomUUID(),
    onUnreadable: (error) => {
      if (unreadable === error) return;
      unreadable = error;
      tellUnreadable(pi, error);
    },
    onMaintenance: (request) => maintenance.queue?.receive(request),
    onConnect: () => {
      unreadable = undefined;
      pi.events.emit("fleet:connected", {});
      worker?.flush();
      worker?.reconcile();
      failures.flush();
      jobs?.sync().catch(() => undefined);
    },
    onPush: (push) => {
      void extensionsReady.then(() => {
        deliverPush(push);
      });
    },
  });
  const deliverPush = ({ entry, name, mode, again = false }: Push): void => {
    const seen = again ? injectedAgain : injected;
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    const deliver = (extra: string): void => {
      sendEntry(pi, entry, mode, format(entry, name, again) + extra);
      if (entry.fields["compaction"] === true) {
        failures.expectCompaction();
        compact();
      }
      pi.events.emit("fleet:delivered", { entryId: entry.id, mode });
      if (entry.kind === "job-result") jobs?.finished(entry.fields["job"]);
      noteWorkerInput(entry, entry.fields["recovery"] !== undefined);
    };
    if (role === "mate" && isMergedReport(entry)) void closeMerged(link, entry).then(deliver);
    else deliver("");
  };
  const noteWorkerInput = (entry: Entry, recovery: boolean): void => {
    worker?.receive(entry);
    if (recovery) worker?.checkingHealth();
    else worker?.reset();
  };
  const jobs = role === "worker" ? workerTools(pi, link, { url, token }) : undefined;
  registerDropJob(pi, link);
  registerGuard(pi);
  const failures = new Failures(link);
  failures.register(pi);
  const worker = jobs === undefined ? undefined : new WorkerRun(link, jobs, failures);
  worker?.register(pi);
  const lanes = lane === "main" ? registerLanes(pi, HOME(), link) : undefined;
  let stow: (() => Promise<string | undefined>) | undefined;
  if (role === "mate") {
    registerQuestions(pi, link, () => sessionFile);
    registerMate(pi, link, { url, piArgs: piArgs() }, lanes);
    registerRestart(pi, link, { url, piArgs: piArgs() }, lane === "main" ? HOME() : undefined);
    stow = registerStow(pi, HOME(), lane, link);
    registerPlan(pi, link);
  }
  if (lane === "main") {
    refreshEveryCloneOnFirstConnect(pi, link);
    registerUpdate(pi, HOME(), link);
  }

  maintenance.queue = new MaintenanceQueue(pi, link, ctx, role === "worker", stow);
  applyCachePolicy(role);
  applyContextPolicy(role);
  applyCompactionBackoff();
  applyCompactionPolicy();
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${ROLE_PROMPTS[role]}${role === "mate" ? mateContract() : ""}`,
  }));
  pi.on("session_shutdown", () => {
    link.stop();
  });
  registerIntake(pi, link);
  reportActivity(pi, link, () => (jobs?.waiting === true ? "waiting" : "idle"));
  link.start();
}

const AVOID_FLAG = "--fleet-avoid=";

function exportAvoid(): void {
  const given = process.argv.find((arg) => arg.startsWith(AVOID_FLAG));
  if (given !== undefined) process.env["PI_TIERS_AVOID"] = given.slice(AVOID_FLAG.length);
}

export default function fleet(pi: ExtensionAPI): void {
  exportAvoid();
  pi.registerFlag("fleet-avoid", {
    type: "string",
    description: "Comma-separated providers the model router must skip",
  });
  pi.registerFlag("fleet-url", { type: "string", description: "The cardd websocket URL" });
  pi.registerFlag("fleet-token", { type: "string", description: "This session's cardd token" });
  pi.registerFlag("fleet-role", { type: "string", description: "worker or mate" });
  let started = false;
  let extensionsLoaded: () => void = () => undefined;
  const extensionsReady = new Promise<void>((resolve) => {
    extensionsLoaded = resolve;
  });
  pi.on("resources_discover", () => {
    extensionsLoaded();
  });
  pi.on("session_start", (_event, ctx) => {
    const found = config(pi);
    if (started || found === undefined) return;
    started = true;
    start(
      pi,
      found,
      ctx.sessionManager.getSessionFile(),
      () => {
        ctx.compact();
      },
      ctx,
      extensionsReady,
    );
    if (found.lane !== undefined) titleMate(pi, found.lane).catch(() => undefined);
  });
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Entry } from "@fleet/protocol";
import { AccountRotation } from "./account-rotation.ts";
import { showBoardLink } from "./board-link.ts";
import { registerBranch } from "./branch.ts";
import { registerGuard } from "./guard.ts";
import { applyCacheBreakLog } from "./cache-breaks.ts";
import { applyCachePolicy } from "./cache-policy.ts";
import { applyCompactionBackoff } from "./compaction-backoff.ts";
import { applyCompactionPolicy } from "./compaction-policy.ts";
import { applyContextPolicy } from "./context-policy.ts";
import { refreshEveryCloneOnFirstConnect } from "./clones.ts";
import { watchMainCardd } from "./cardd-watch.ts";
import { Failures } from "./failure.ts";
import { format, idsInSessionFile } from "./inbox.ts";
import { closeMerged, isMergedReport } from "./auto-close.ts";
import { registerIntake } from "./intake.ts";
import { Jobs, registerDropJob } from "./jobs.ts";
import { enableCodemode } from "./codemode.ts";
import type { Bws, BwsConfig } from "./bws.ts";
import { bwsConfig, readLaneConfig, workerPiArgs, type LaneConfig } from "./lane-config.ts";
import { applyEnvSecrets, bwsFor, laneToken } from "./lane-secrets.ts";
import { Link, type Push } from "./link.ts";
import { showPane } from "./pane/index.ts";
import { shimKillCommands } from "./shims.ts";
import { registerLanes } from "./lanes.ts";
import { registerPlan } from "./plan.ts";
import { processId } from "./process-id.ts";
import { reportActivity, trackRun } from "./progress.ts";
import { MUTABLE_TAIL } from "./cache-ttl.ts";
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
  readonly notes: readonly string[];
  readonly secrets?: { readonly bws: Bws; readonly env: Readonly<Record<string, string>> };
}

const EXTENSION = fileURLToPath(import.meta.url);
const HOME = (): string => process.cwd();

function exportHosts(lane: LaneConfig): void {
  process.env["FLEET_HOSTS"] ??= JSON.stringify(lane.hosts);
  process.env["FLEET_HOST"] ??= lane.host ?? "";
  process.env["FLEET_ROOTS"] ??= JSON.stringify(lane.roots);
}

function forwardedBws(text: string | undefined): BwsConfig | undefined {
  if (text === undefined || text === "") return undefined;
  const parsed: unknown = JSON.parse(text);
  return bwsConfig("--fleet-bws", parsed);
}

function secretsOf(settings: BwsConfig | undefined): Config["secrets"] {
  const bws = bwsFor(settings);
  return settings === undefined || bws === undefined ? undefined : { bws, env: settings.env };
}

function suppliedConfig(pi: ExtensionAPI): Config | undefined {
  const value = (flag: string, env: string): string | undefined => {
    const fromFlag = pi.getFlag(flag);
    return typeof fromFlag === "string" && fromFlag !== "" ? fromFlag : process.env[env];
  };
  const url = value("fleet-url", "FLEET_URL");
  const token = value("fleet-token", "FLEET_TOKEN");
  const role = value("fleet-role", "FLEET_ROLE");
  const named = process.env["FLEET_LANE"];
  if (url === undefined || token === undefined || (role !== "worker" && role !== "mate"))
    return undefined;
  const secrets = secretsOf(forwardedBws(value("fleet-bws", "FLEET_BWS")));
  return {
    url,
    token,
    role,
    notes: [],
    ...(role === "worker" || named === undefined || named === "" ? {} : { lane: named }),
    ...(secrets === undefined ? {} : { secrets }),
  };
}

async function laneConfig(lane: LaneConfig): Promise<Config> {
  exportHosts(lane);
  const forwarded = lane.bws === undefined ? [] : [`--fleet-bws=${JSON.stringify(lane.bws)}`];
  process.env["FLEET_PI_ARGS"] ??= JSON.stringify([...workerPiArgs(lane), ...forwarded]);
  const secrets = secretsOf(lane.bws);
  const resolved = await laneToken(lane, secrets?.bws);
  if (resolved.value === undefined) throw new Error(`fleet: ${resolved.note}`);
  return {
    url: lane.url,
    token: resolved.value,
    role: "mate",
    lane: lane.lane,
    notes: secrets === undefined ? [] : [resolved.note],
    ...(secrets === undefined ? {} : { secrets }),
  };
}

async function config(pi: ExtensionAPI): Promise<Config | undefined> {
  const supplied = suppliedConfig(pi);
  if (supplied !== undefined) return supplied;
  const lane = readLaneConfig(HOME());
  return lane === undefined ? undefined : laneConfig(lane);
}

function announce(ctx: ExtensionContext, notes: readonly string[]): void {
  if (notes.length === 0) return;
  const lines = notes.map((note) => `fleet: ${note}`);
  if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
  else for (const line of lines) console.error(line);
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

function appendRolePrompt(pi: ExtensionAPI, role: "mate" | "worker"): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${ROLE_PROMPTS[role]}${role === "mate" ? MUTABLE_TAIL : ""}`,
  }));
}

function appendMateContract(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}${mateContract()}`,
  }));
}

function piArgs(): string[] {
  const parsed: unknown = JSON.parse(process.env["FLEET_PI_ARGS"] ?? "[]");
  return Array.isArray(parsed) ? parsed.filter((arg) => typeof arg === "string") : [];
}

function tellLaunchLost(pi: ExtensionAPI): (text: string) => void {
  return (text) => {
    pi.sendMessage(
      { customType: "fleet-launch", content: `[fleet] launch: ${text}`, display: true },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };
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

function afterEntry(link: Link, entry: Entry): Promise<string> | undefined {
  return isMergedReport(entry) ? closeMerged(link, entry) : undefined;
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

function deliverAfterSync(
  jobs: Jobs,
  seen: Set<number>,
  id: number,
  deliver: (extra: string) => void,
): void {
  jobs.sync().then(
    () => {
      deliver("");
    },
    () => {
      seen.delete(id);
    },
  );
}

function idsClearedOnSettle(pi: ExtensionAPI): Set<number> {
  const ids = new Set<number>();
  pi.on("agent_settled", () => {
    ids.clear();
  });
  return ids;
}

function applyPolicies(pi: ExtensionAPI, ctx: ExtensionContext, role: Config["role"]): void {
  applyCachePolicy(role);
  applyCacheBreakLog(pi, ctx);
  applyContextPolicy(role);
  applyCompactionBackoff();
  applyCompactionPolicy();
  if (role === "mate") appendMateContract(pi);
}

function start(
  pi: ExtensionAPI,
  { url, token, role, lane }: Config,
  sessionFile: string | undefined,
  compact: () => void,
  ctx: ExtensionContext,
  extensionsReady: Promise<void>,
): void {
  enableCodemode(pi);
  const runInProgress = trackRun(pi);
  const inFileAtStart = idsInSessionFile(sessionFile);
  const injected = new Set(inFileAtStart);
  const injectedAgain = idsClearedOnSettle(pi);
  let unreadable: string | undefined;
  const maintenance: { queue?: MaintenanceQueue } = {};
  const link = new Link({
    url,
    token,
    inFile: () => idsInSessionFile(sessionFile),
    process: processId(),
    running: runInProgress,
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
      if (entry.fields["compaction"] === true) compact();
      pi.events.emit("fleet:delivered", { entryId: entry.id, mode });
      if (entry.fields["recovery"] !== undefined) worker?.checkingHealth();
      else worker?.reset();
    };
    const mateWork = role === "mate" ? afterEntry(link, entry) : undefined;
    if (mateWork !== undefined) void mateWork.then(deliver);
    else if (entry.kind === "job-result" && jobs !== undefined)
      deliverAfterSync(jobs, seen, entry.id, deliver);
    else deliver("");
  };
  const jobs = role === "worker" ? workerTools(pi, link, { url, token }) : undefined;
  registerDropJob(pi, link);
  registerGuard(pi);
  const failures = new Failures(link);
  failures.register(pi);
  const worker = jobs === undefined ? undefined : new WorkerRun(link, jobs, failures);
  worker?.register(pi);
  const lanes = lane === "main" ? registerLanes(pi, HOME(), link, ctx) : undefined;
  let stow: (() => Promise<string | undefined>) | undefined;
  appendRolePrompt(pi, role);
  if (role === "mate") {
    registerQuestions(pi, link, () => sessionFile);
    const launch = { url, piArgs: piArgs(), extension: EXTENSION, lost: tellLaunchLost(pi) };
    registerMate(pi, link, launch, lanes, lane === "main");
    registerRestart(pi, link, launch, lane === "main" ? HOME() : undefined);
    stow = registerStow(pi, HOME(), lane, link);
    registerPlan(pi, link);
    showBoardLink(ctx, url);
    if (lane === "main") showPane(pi, link, ctx);
  }
  watchMainCardd(pi, link, { url, role, lane }, HOME());
  if (lane === "main") {
    refreshEveryCloneOnFirstConnect(pi, link);
    registerUpdate(pi, HOME(), link);
  }
  maintenance.queue = new MaintenanceQueue(pi, link, ctx, role === "worker", stow);
  applyPolicies(pi, ctx, role);
  pi.on("session_shutdown", () => {
    worker?.dispose();
    link.stop();
  });
  registerIntake(pi, link, inFileAtStart);
  reportActivity(pi, link, () => (jobs?.waiting === true ? "waiting" : "idle"));
  link.start();
}

const AVOID_FLAG = "--fleet-avoid=";

function exportAvoid(): void {
  const given = process.argv.find((arg) => arg.startsWith(AVOID_FLAG));
  if (given !== undefined) process.env["PI_TIERS_AVOID"] = given.slice(AVOID_FLAG.length);
}

export default function fleet(pi: ExtensionAPI): void {
  shimKillCommands();
  exportAvoid();
  pi.registerFlag("fleet-avoid", {
    type: "string",
    description: "Comma-separated providers the model router must skip",
  });
  pi.registerFlag("fleet-url", { type: "string", description: "The cardd websocket URL" });
  pi.registerFlag("fleet-token", { type: "string", description: "This session's cardd token" });
  pi.registerFlag("fleet-role", { type: "string", description: "worker or mate" });
  pi.registerFlag("fleet-bws", {
    type: "string",
    description: "Where to read this session's bws secrets, as JSON without any secret value",
  });
  const rotation = new AccountRotation(pi);
  let started = false;
  let extensionsLoaded: () => void = () => undefined;
  const extensionsReady = new Promise<void>((resolve) => {
    extensionsLoaded = resolve;
  });
  pi.on("resources_discover", () => {
    extensionsLoaded();
  });
  pi.on("session_start", async (_event, ctx) => {
    const found = await config(pi);
    if (started || found === undefined) return;
    started = true;
    const applied =
      found.secrets === undefined
        ? []
        : await applyEnvSecrets(found.secrets.bws, found.secrets.env);
    announce(ctx, [...found.notes, ...applied]);
    if (found.role === "worker") await rotation.adopt(ctx);
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

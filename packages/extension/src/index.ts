import { abortWithoutMateContract, readPromptFile } from "./prompt-file.ts";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { startDiscordBridge } from "./discord/bridge.ts";
import { Complaints } from "./complaints.ts";
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
import {
  bwsConfig,
  exportHosts,
  readLaneConfig,
  workerPiArgs,
  type LaneConfig,
} from "./lane-config.ts";
import { applyEnvSecrets, bwsFor, laneToken } from "./lane-secrets.ts";
import { Link, type Push } from "./link.ts";
import { shimKillCommands } from "./shims.ts";
import { registerLanes } from "./lanes.ts";
import { registerPlan } from "./plan.ts";
import { processId } from "./process-id.ts";
import { reportActivity, trackRun } from "./progress.ts";
import { MUTABLE_TAIL } from "./cache-ttl.ts";
import { WORKER_PROMPT } from "./prompts.ts";
import { MaintenanceQueue, STALE_RELOAD_FLAG } from "./maintenance.ts";
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
  readonly fleetProject?: boolean;
  readonly secrets?: { readonly bws: Bws; readonly env: Readonly<Record<string, string>> };
}

const EXTENSION = fileURLToPath(import.meta.url);
const HOME = (): string => process.cwd();

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
  const fleetProject = pi.getFlag("fleet-project");
  if (url === undefined || token === undefined || (role !== "worker" && role !== "mate"))
    return undefined;
  const secrets = secretsOf(forwardedBws(value("fleet-bws", "FLEET_BWS")));
  return {
    url,
    token,
    role,
    notes: [],
    ...roleFields(role, fleetProject, named),
    ...(secrets === undefined ? {} : { secrets }),
  };
}

function roleFields(
  role: "worker" | "mate",
  fleetProject: unknown,
  named: string | undefined,
): Partial<Config> {
  if (role === "worker")
    return fleetProject === "true" || fleetProject === "false"
      ? { fleetProject: fleetProject === "true" }
      : {};
  return named === undefined || named === "" ? {} : { lane: named };
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

function gitCommonDir(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status !== 0) return undefined;
  try {
    return realpathSync(result.stdout.replace(/\n$/, ""));
  } catch {
    return undefined;
  }
}

function isFleetCheckout(root: string, fleetProject: boolean | undefined): boolean {
  if (fleetProject !== undefined) return fleetProject;
  const common = gitCommonDir(root);
  return common !== undefined && common === gitCommonDir(dirname(EXTENSION));
}

function contributorGuideForWorkers(pi: ExtensionAPI, fleetProject: boolean | undefined): void {
  const root = HOME();
  if (!isFleetCheckout(root, fleetProject)) return;
  const agents = join(root, "AGENTS.md");
  const guide = join(root, "CONTRIBUTING.md");
  pi.on("before_agent_start", (event) => {
    const files = event.systemPromptOptions.contextFiles;
    const own = files.findIndex((file) => resolve(file.path) === agents);
    if (own !== -1) files.splice(own, 1);
    const content = readPromptFile(guide);
    if (content !== undefined)
      files.splice(own === -1 ? files.length : own, 0, { path: guide, content });
    return undefined;
  });
}

function contractForMates(pi: ExtensionAPI): void {
  const path = join(HOME(), "AGENTS.md");
  const loaded = readPromptFile(path);
  const present = (ctx: ExtensionContext): boolean => {
    const content = readPromptFile(path);
    if (content !== undefined && content.trim() !== "") {
      if (ctx.hasUI) ctx.ui.setWidget("fleet-mate-contract", undefined);
      return true;
    }
    abortWithoutMateContract(ctx, path);
    return false;
  };
  pi.on("before_agent_start", (event, ctx) => {
    if (!present(ctx)) return undefined;
    const files = event.systemPromptOptions.contextFiles;
    if (loaded !== undefined && !files.some((file) => resolve(file.path) === path))
      files.push({ path, content: loaded });
    return undefined;
  });
  pi.on("agent_start", (_event, ctx) => {
    present(ctx);
  });
}

function appendRolePrompt(pi: ExtensionAPI, role: "mate" | "worker"): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt:
      role === "mate"
        ? `${event.systemPrompt}${MUTABLE_TAIL}`
        : `${event.systemPrompt}\n\n${WORKER_PROMPT}`,
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

function tellUnreadable(pi: ExtensionAPI, error: string, reloading: boolean): void {
  const next = reloading
    ? "This session runs older code than cardd, so it reloads itself at its next safe point, on the same conversation."
    : "It may run other code than this extension. The session keeps reconnecting.";
  pi.sendMessage(
    {
      customType: "fleet-link",
      content: `[fleet] link: cardd sent a message this session cannot read (${error}). ${next}`,
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
  { url, token, role, lane, fleetProject }: Config,
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
      tellUnreadable(pi, error, maintenance.queue?.reloadForStaleCode() === true);
    },
    onUnreadableResult: () => {
      maintenance.queue?.reloadForStaleCode();
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
  const complaints = new Complaints(pi, link);
  complaints.register(role);
  const worker = jobs === undefined ? undefined : new WorkerRun(link, jobs, failures);
  worker?.register(pi);
  const lanes = lane === "main" ? registerLanes(pi, HOME(), link, ctx) : undefined;
  let stow: (() => Promise<string | undefined>) | undefined;
  if (role === "worker") contributorGuideForWorkers(pi, fleetProject);
  else contractForMates(pi);
  appendRolePrompt(pi, role);
  if (role === "mate") {
    registerQuestions(pi, link, () => sessionFile);
    const launch = { url, piArgs: piArgs(), extension: EXTENSION, lost: tellLaunchLost(pi) };
    registerMate(pi, link, launch, lanes, lane === "main", complaints);
    registerRestart(pi, link, launch, lane === "main" ? HOME() : undefined);
    stow = registerStow(pi, HOME(), lane, link);
    registerPlan(pi, link);
    showBoardLink(ctx, url);
  }
  watchMainCardd(pi, link, { url, role, lane }, HOME());
  if (lane === "main") {
    refreshEveryCloneOnFirstConnect(pi, link);
    registerUpdate(pi, HOME(), link);
    startDiscordBridge(pi, HOME(), ctx);
  }
  maintenance.queue = new MaintenanceQueue(pi, link, ctx, role === "worker", stow, { url, token });
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
  pi.registerFlag("fleet-project", {
    type: "string",
    description: "Whether the registered worker project is Fleet (true or false)",
  });
  pi.registerFlag(STALE_RELOAD_FLAG, {
    type: "string",
    description:
      "When this process last relaunched itself because cardd's messages were unreadable",
  });
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

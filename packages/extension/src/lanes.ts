import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { costLine, DAY_MS, type CostRow } from "./cost.ts";
import { DISK_CLEARED, DISK_MESSAGE, diskWatch, type Alert } from "./disk-alarm.ts";
import {
  HostCommandFailed,
  HostUnread,
  HostUnreachable,
  onFleetRoot,
  onHost,
  records,
} from "./host.ts";
import { sidebarHostName } from "./arrange.ts";
import type { Link } from "./link.ts";
import { isRecord, readLaneConfig, type LaneConfig } from "./lane-config.ts";
import {
  MAINTENANCE_COMMAND_MS,
  MAINTENANCE_OUTCOMES_CAPABILITY,
  MAINTENANCE_OUTCOMES_OPTION,
  MAINTENANCE_PROBE_MS,
  remainingMs,
} from "./maintenance-budget.ts";
import { readShared } from "./standing.ts";
import type { LaneRow } from "./views.ts";

const LAUNCH = fileURLToPath(new URL("./launch.ts", import.meta.url));
const REMOTE_WAIT_MS = 90_000;
const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export const hostsOf = (config: LaneConfig): string[] => ["local", ...Object.keys(config.hosts)];

export async function fleet(
  config: LaneConfig,
  host: string,
  args: readonly string[],
  wait = REMOTE_WAIT_MS,
  hard = false,
): Promise<string> {
  if (host === "local") return onHost(host, [process.execPath, LAUNCH, ...args], wait, hard);
  return onFleetRoot(host, config.roots[host], args, wait, hard);
}

async function rows(
  config: LaneConfig,
  host: string,
  args: readonly string[],
): Promise<Record<string, unknown>[]> {
  const out = (await fleet(config, host, [...args, "--json"])).trim().split("\n").at(-1) ?? "[]";
  return records(JSON.parse(out));
}

const text = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : "";
};
const describe = (host: string, row: Record<string, unknown>): string => {
  const state = text(row, "state") || text(row, "action");
  const more = text(row, "reason") || text(row, "detail");
  return `${text(row, "lane")} (${host}): ${state}${more === "" ? "" : ` - ${more}`}`;
};

async function everyLane(
  config: LaneConfig,
): Promise<{ host: string; row: Record<string, unknown> }[]> {
  const out: { host: string; row: Record<string, unknown> }[] = [];
  for (const host of hostsOf(config)) {
    for (const row of await rows(config, host, ["status"])) out.push({ host, row });
  }
  return out;
}

async function placementRows(config: LaneConfig, host: string): Promise<Record<string, unknown>[]> {
  const out = (await fleet(config, host, ["status", "--placement", "--json"]))
    .trim()
    .split("\n")
    .at(-1);
  const parsed: unknown = JSON.parse(out ?? "");
  const homes = records(parsed);
  if (!Array.isArray(parsed) || homes.length !== parsed.length)
    throw new Error(`invalid mate placement on ${host}`);
  return homes;
}

function placedName(host: string, row: Record<string, unknown>): string {
  if (host !== "local") return host;
  return sidebarHostName(typeof row["host"] === "string" ? row["host"] : undefined);
}

function soleHosts(runningHosts: Map<string, string[]>): Map<string, string> {
  const found = new Map<string, string>();
  for (const [lane, hosts] of runningHosts) {
    const [host] = hosts;
    if (host !== undefined && hosts.length === 1) found.set(lane, host);
  }
  return found;
}

async function collectRunning(
  config: LaneConfig,
  host: string,
  runningHosts: Map<string, string[]>,
): Promise<void> {
  for (const row of await placementRows(config, host)) {
    const lane = text(row, "lane");
    const running = row["mate"];
    if (lane === "" || typeof running !== "boolean")
      throw new Error(`invalid mate placement on ${host}`);
    if (!running || (host === "local" && lane === config.lane)) continue;
    runningHosts.set(lane, [...(runningHosts.get(lane) ?? []), placedName(host, row)]);
  }
}

export async function mateHosts(config: LaneConfig): Promise<Map<string, string>> {
  const here = sidebarHostName(process.env["FLEET_HOST"]);
  const runningHosts = new Map([[config.lane, [here]]]);
  for (const host of hostsOf(config)) await collectRunning(config, host, runningHosts);
  return soleHosts(runningHosts);
}

async function hostOfLane(config: LaneConfig, lane: string): Promise<string> {
  const found = (await everyLane(config)).find((each) => text(each.row, "lane") === lane);
  if (found === undefined) throw new Error(`no lane ${lane} is configured on any host`);
  return found.host;
}

function sharedArgs(home: string): string[] {
  const bytes = readShared(home);
  if (bytes === undefined) return ["shared", "--absent"];
  return ["shared", "--content", Buffer.from(bytes, "utf8").toString("base64")];
}

const preservedLines = (host: string, out: string): string[] =>
  out
    .split("\n")
    .filter((line) => line.includes("preserved as"))
    .map((line) => `${line} (on ${host})`);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function publishShared(home: string): Promise<string | undefined> {
  const config = readLaneConfig(home);
  if (config === undefined) return undefined;
  const failures: string[] = [];
  const notes: string[] = [];
  for (const host of hostsOf(config)) {
    try {
      notes.push(...preservedLines(host, await fleet(config, host, sharedArgs(home))));
    } catch (error) {
      failures.push(`${host}: ${messageOf(error)}`);
    }
  }
  if (failures.length > 0) notes.push(`Shared preferences did not reach ${failures.join("; ")}`);
  return notes.length === 0 ? undefined : notes.join("\n");
}

export type LaneStates = () => Promise<{
  lanes: LaneRow[];
  unreachable: { host: string; error: string }[];
}>;

const LaneParams = Type.Object({
  name: Type.String({
    minLength: 1,
    description: 'The lane name, such as cleo, or "all" to restart every lane',
  }),
  action: Type.Enum(["start", "stop", "restart"]),
});

const heldHosts = new Set<string>();
const hostQueues = new Map<string, Promise<void>>();

export function withLanes<T>(hosts: readonly string[], work: () => Promise<T>): Promise<T> {
  const earlier = Promise.all(hosts.map((host) => hostQueues.get(host) ?? Promise.resolve()));
  const run = earlier.then(async () => {
    for (const host of hosts) heldHosts.add(host);
    try {
      return await work();
    } finally {
      for (const host of hosts) heldHosts.delete(host);
    }
  });
  const finished = run.then(
    () => undefined,
    () => undefined,
  );
  for (const host of hosts) hostQueues.set(host, finished);
  return run;
}

export async function restartLane(home: string, lane: string): Promise<string> {
  const config = readLaneConfig(home);
  if (config === undefined) throw new Error("only a mate with lanes can restart one");
  return withLanes(hostsOf(config), () => act(config, lane, "restart"));
}

async function restartAll(config: LaneConfig): Promise<string[]> {
  const lines: string[] = [];
  for (const host of hostsOf(config)) {
    try {
      for (const row of await rows(config, host, ["restart"])) lines.push(describe(host, row));
    } catch (error) {
      lines.push(`${host}: cannot be reached - ${messageOf(error)}`);
    }
  }
  return lines.length === 0 ? ["No lanes are configured."] : lines;
}

async function act(
  config: LaneConfig,
  lane: string,
  action: "start" | "stop" | "restart",
): Promise<string> {
  const host = await hostOfLane(config, lane);
  if (action === "stop") {
    await fleet(config, host, ["stop", lane]);
    return `${lane} (${host}): stopped`;
  }
  const out = await rows(config, host, [action === "start" ? "up" : "restart", lane]);
  return out.map((row) => describe(host, row)).join("\n");
}

export function registerLanes(
  pi: ExtensionAPI,
  home: string,
  link: Link,
  ctx: ExtensionContext,
): LaneStates | undefined {
  const config = readLaneConfig(home);
  if (config === undefined) return undefined;
  pi.registerTool({
    name: "lane",
    label: "Lane",
    description:
      "Starts, stops, or restarts a second mate's lane on its host. start also starts a lane that was stopped by hand or held for crashing; a mate that runs is left alone. stop holds the lane, so nothing restarts it until start; its conversation stays. restart starts the mate again on its own conversation. name \"all\" with restart restarts every lane that is not held, on every host: that restarts the fleet. Never touches cardd. board shows each lane's state.",
    parameters: LaneParams,
    execute: async (_id, { name, action }) => {
      if (name !== "all") {
        if (action === "stop")
          await link.call("lane.stopping", { lane: name }).catch(() => undefined);
        return reply(await withLanes(hostsOf(config), () => act(config, name, action)));
      }
      if (action !== "restart")
        throw new Error('lane "all" only restarts: name each lane to start or stop it');
      return reply((await withLanes(hostsOf(config), () => restartAll(config))).join("\n"));
    },
  });
  keepRunning(pi, config, home, ctx);
  return async () => {
    const lanes: LaneRow[] = [];
    const unreachable: { host: string; error: string }[] = [];
    for (const host of hostsOf(config)) {
      try {
        for (const row of await rows(config, host, ["status"])) {
          const detail = text(row, "reason") || text(row, "detail");
          lanes.push({ lane: text(row, "lane"), host, state: text(row, "state"), detail });
        }
      } catch (error) {
        unreachable.push({ host, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { lanes, unreachable };
  };
}

const COST_NOTICE = join("state", "cost-notice");

function noticeDue(home: string, now: number): boolean {
  try {
    return now - Number(readFileSync(join(home, COST_NOTICE), "utf8")) >= DAY_MS;
  } catch {
    return true;
  }
}

const isCostRow = (row: Record<string, unknown>): row is Record<string, unknown> & CostRow =>
  typeof row["lane"] === "string" &&
  typeof row["dollars"] === "number" &&
  typeof row["coldStarts"] === "number";

async function costLines(config: LaneConfig): Promise<string[]> {
  const lines: string[] = [];
  for (const host of hostsOf(config)) {
    lines.push(...(await rows(config, host, ["cost"])).filter(isCostRow).map(costLine));
  }
  return lines;
}

const INTERVAL_MS = Number(process.env["FLEET_SUPERVISE_MS"]) || 60_000;

const MAINTENANCE_ACTIONS = new Set(["running", "started", "held", "stopped", "unread"]);

async function supportsMaintenanceOutcomes(
  config: LaneConfig,
  host: string,
  timeout: number,
): Promise<boolean> {
  if (host === "local") return true;
  try {
    const out = await fleet(config, host, [MAINTENANCE_OUTCOMES_OPTION], timeout, true);
    if (out.trim() === MAINTENANCE_OUTCOMES_CAPABILITY) return true;
  } catch (error) {
    if (error instanceof HostUnreachable) throw error;
    const refusal = `sh on ${host} failed: fleet: Unknown option '${MAINTENANCE_OUTCOMES_OPTION}'`;
    if (error instanceof HostCommandFailed && error.exitCode === 2 && !error.hasOutput) {
      const firstLine = error.message.split("\n")[0];
      if (
        firstLine === refusal ||
        firstLine?.startsWith(`${refusal}. To specify a positional argument `)
      )
        return false;
    }
    throw new Error(`could not verify maintenance support on ${host}: ${messageOf(error)}`);
  }
  throw new Error(`could not verify maintenance support on ${host}: unexpected capability reply`);
}

async function maintenanceResult(config: LaneConfig, host: string, offsets: Map<string, number>) {
  const deadline = performance.now() + MAINTENANCE_COMMAND_MS;
  const typed = await supportsMaintenanceOutcomes(
    config,
    host,
    Math.min(MAINTENANCE_PROBE_MS, remainingMs(deadline)),
  );
  const timeout = remainingMs(deadline);
  if (timeout === 0) throw new HostUnread("maintenance deadline reached before sweep");
  const args = ["up", "--maintenance", "--json"];
  if (typed) {
    const offset = offsets.get(host) ?? 0;
    args.push(MAINTENANCE_OUTCOMES_OPTION, String(offset));
    offsets.set(host, offset + 1);
  }
  const out = await fleet(config, host, args, timeout, true).catch((error: unknown) => {
    if (!typed || error instanceof HostUnreachable) throw error;
    throw new HostUnread(messageOf(error));
  });
  try {
    return readMaintenanceResult(out, host, typed);
  } catch (error) {
    throw new HostUnread(messageOf(error));
  }
}

function readMaintenanceResult(out: string, host: string, typed: boolean) {
  const answer: unknown = JSON.parse(out.trim().split("\n").at(-1) ?? "");
  let list = answer;
  let failed: string | undefined;
  let missing: Set<string> | undefined;
  if (typed) {
    if (!isRecord(answer)) throw new Error(`fleet on ${host} returned no maintenance envelope`);
    if (Object.hasOwn(answer, "failed")) {
      failed = text(answer, "failed");
      if (failed.trim() === "") throw new Error(`fleet on ${host} returned no failure detail`);
    }
    const expected = answer["expected"];
    if (
      !Array.isArray(expected) ||
      !expected.every((lane) => typeof lane === "string" && lane.trim() !== "")
    )
      throw new Error(`fleet on ${host} returned no valid expected lane set`);
    missing = new Set<string>(expected);
    if (missing.size !== expected.length)
      throw new Error(`fleet on ${host} returned duplicate expected lanes`);
    list = answer["outcomes"];
  }
  const results = records(list);
  if (!Array.isArray(list) || results.length !== list.length)
    throw new Error(`fleet on ${host} returned an incomplete maintenance list`);
  for (const row of results) {
    const action = text(row, "action");
    if (
      text(row, "lane").trim() === "" ||
      (missing !== undefined && !missing.delete(text(row, "lane"))) ||
      !MAINTENANCE_ACTIONS.has(action) ||
      (!typed && action === "unread") ||
      (action === "held" && text(row, "detail") === "")
    )
      throw new Error(`fleet on ${host} returned an incomplete maintenance result`);
  }
  if (failed === undefined && missing !== undefined && missing.size > 0)
    throw new Error(`fleet on ${host} omitted maintenance outcomes`);
  return { results, failed };
}

function deliver(
  pi: ExtensionAPI,
  customType: string,
  content: string,
  urgent: boolean,
  details?: Record<string, string>,
): void {
  pi.sendMessage(
    { customType, content, display: true, ...(details === undefined ? {} : { details }) },
    urgent ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
  );
}

function diskSayer(pi: ExtensionAPI, isDown: () => boolean): (alert: Alert) => boolean {
  return ({ text, urgent, crossing }) => {
    if (isDown()) return false;
    const details = crossing === undefined ? undefined : { crossing };
    deliver(pi, DISK_MESSAGE, `[fleet] disk: ${text}`, urgent, details);
    return true;
  };
}

function diskWatcher(
  pi: ExtensionAPI,
  config: LaneConfig,
  ctx: ExtensionContext,
  isDown: () => boolean,
): (host: string) => Promise<void> {
  return diskWatch({
    ask: (host, args) => fleet(config, host, args),
    send: diskSayer(pi, isDown),
    clear: (crossing) => {
      if (!isDown()) pi.appendEntry(DISK_CLEARED, { crossing });
    },
    idle: () => !isDown() && ctx.isIdle() && !ctx.hasPendingMessages(),
    entries: () => (isDown() ? [] : ctx.sessionManager.getEntries()),
  });
}

function costNotice(
  pi: ExtensionAPI,
  config: LaneConfig,
  home: string,
  isDown: () => boolean,
): () => Promise<void> {
  let costing = false;
  return async () => {
    if (costing || isDown() || !noticeDue(home, Date.now())) return;
    costing = true;
    try {
      const lines = await costLines(config).catch(() => []);
      if (lines.length === 0 || isDown()) return;
      mkdirSync(join(home, "state"), { recursive: true });
      writeFileSync(join(home, COST_NOTICE), String(Date.now()));
      pi.sendMessage(
        {
          customType: "fleet-cost",
          content: `[fleet] cost, last 24 hours:\n${lines.join("\n")}`,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } finally {
      costing = false;
    }
  };
}

function keepRunning(
  pi: ExtensionAPI,
  config: LaneConfig,
  home: string,
  ctx: ExtensionContext,
): void {
  const unreachable = new Set<string>();
  const maintenanceFailures = new Map<string, string>();
  const sweepOffsets = new Map<string, number>();
  const diskFailures = new Map<string, string>();
  const unshared = new Set<string>();
  const supervising = new Set<string>();
  let shutDown = false;
  const isDown = (): boolean => shutDown;
  const tell = (lines: readonly string[], urgent: boolean): void => {
    if (lines.length === 0 || shutDown) return;
    deliver(pi, "fleet-lanes", `[fleet] lanes: ${lines.join("; ")}`, urgent);
  };
  const share = async (host: string): Promise<void> => {
    try {
      tell(preservedLines(host, await fleet(config, host, sharedArgs(home))), false);
      if (unshared.delete(host)) tell([`shared preferences reach ${host} again`], false);
    } catch (error) {
      if (error instanceof HostUnreachable) throw error;
      if (unshared.has(host)) return;
      unshared.add(host);
      tell([`shared preferences did not reach ${host}: ${messageOf(error)}`], false);
    }
  };
  const watchDisk = diskWatcher(pi, config, ctx, isDown);
  const reportDown = (host: string, error: unknown, failures: Map<string, string>): void => {
    if (error instanceof HostUnread) return;
    const message = messageOf(error);
    if (error instanceof HostUnreachable) {
      if (unreachable.has(host)) return;
      unreachable.add(host);
      tell([`${host} cannot be reached: ${message}`], true);
    } else if (failures.get(host) !== message) {
      failures.set(host, message);
      tell([`${host} failed: ${message}`], true);
    }
  };
  const maintain = async (host: string): Promise<void> => {
    await share(host);
    const { results: out, failed } = await maintenanceResult(config, host, sweepOffsets);
    if (failed === undefined && out.every((row) => row["action"] !== "unread")) {
      maintenanceFailures.delete(host);
      if (unreachable.delete(host)) tell([`${host} can be reached again`], false);
    }
    const of = (action: string) => out.filter((row) => text(row, "action") === action);
    tell(
      of("started").map((row) => `${text(row, "lane")} started on ${host}`),
      false,
    );
    const held = (row: Record<string, unknown>) =>
      `${text(row, "lane")} on ${host} is held: ${text(row, "detail")}`;
    tell(of("held").map(held), true);
    if (failed !== undefined) throw new Error(failed);
  };
  const checkHost = async (host: string): Promise<void> => {
    try {
      await maintain(host);
    } catch (error) {
      reportDown(host, error, maintenanceFailures);
      if (error instanceof HostUnreachable) return;
    }
    try {
      await watchDisk(host);
      diskFailures.delete(host);
    } catch (error) {
      reportDown(host, error, diskFailures);
    }
  };
  const superviseHost = async (host: string): Promise<void> => {
    if (supervising.has(host) || heldHosts.has(host)) return;
    supervising.add(host);
    try {
      await withLanes([host], () => checkHost(host));
    } finally {
      supervising.delete(host);
    }
  };
  const dailyCost = costNotice(pi, config, home, isDown);
  const tick = async (): Promise<void> => {
    await Promise.all(hostsOf(config).map(superviseHost));
    await dailyCost();
  };
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref();
  void tick();
  pi.on("session_shutdown", () => {
    shutDown = true;
    clearInterval(timer);
  });
}

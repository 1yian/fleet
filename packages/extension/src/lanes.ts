import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { costLine, DAY_MS, type CostRow } from "./cost.ts";
import { HostUnreachable, onFleetRoot, onHost, records } from "./host.ts";
import type { Link } from "./link.ts";
import { readLaneConfig, type LaneConfig } from "./lane-config.ts";
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
): Promise<string> {
  if (host === "local") return onHost(host, [process.execPath, LAUNCH, ...args], wait);
  return onFleetRoot(host, config.roots[host], args, wait);
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

let lanesHeld = false;
let lanesQueue: Promise<void> = Promise.resolve();

export function withLanes<T>(work: () => Promise<T>): Promise<T> {
  const run = lanesQueue.then(async () => {
    lanesHeld = true;
    try {
      return await work();
    } finally {
      lanesHeld = false;
    }
  });
  lanesQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function restartLane(home: string, lane: string): Promise<string> {
  const config = readLaneConfig(home);
  if (config === undefined) throw new Error("only a mate with lanes can restart one");
  return withLanes(() => act(config, lane, "restart"));
}

async function restartAll(config: LaneConfig): Promise<string[]> {
  const lines: string[] = [];
  for (const host of hostsOf(config)) {
    try {
      for (const row of await rows(config, host, ["restart"])) lines.push(describe(host, row));
    } catch (error) {
      lines.push(
        `${host}: cannot be reached - ${error instanceof Error ? error.message : String(error)}`,
      );
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

export function registerLanes(pi: ExtensionAPI, home: string, link: Link): LaneStates | undefined {
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
        return reply(await withLanes(() => act(config, name, action)));
      }
      if (action !== "restart")
        throw new Error('lane "all" only restarts: name each lane to start or stop it');
      return reply((await withLanes(() => restartAll(config))).join("\n"));
    },
  });
  keepRunning(pi, config, home);
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

function keepRunning(pi: ExtensionAPI, config: LaneConfig, home: string): void {
  const unreachable = new Set<string>();
  const unshared = new Set<string>();
  let ticking = false;
  let shutDown = false;
  const isDown = (): boolean => shutDown;
  const tell = (lines: readonly string[], urgent: boolean): void => {
    if (lines.length === 0 || shutDown) return;
    const content = `[fleet] lanes: ${lines.join("; ")}`;
    pi.sendMessage(
      { customType: "fleet-lanes", content, display: true },
      urgent ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
    );
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
  const checkHost = async (host: string): Promise<void> => {
    try {
      await share(host);
      const out = await rows(config, host, ["up", "--maintenance"]);
      if (unreachable.delete(host)) tell([`${host} can be reached again`], false);
      const of = (action: string) => out.filter((row) => text(row, "action") === action);
      tell(
        of("started").map((row) => `${text(row, "lane")} started on ${host}`),
        false,
      );
      const held = (row: Record<string, unknown>) =>
        `${text(row, "lane")} on ${host} is held: ${text(row, "detail")}`;
      tell(of("held").map(held), true);
    } catch (error) {
      if (unreachable.has(host)) return;
      unreachable.add(host);
      const why = error instanceof HostUnreachable ? "cannot be reached" : "failed";
      tell([`${host} ${why}: ${messageOf(error)}`], true);
    }
  };
  const dailyCost = async (): Promise<void> => {
    if (isDown() || !noticeDue(home, Date.now())) return;
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
  };
  const tick = async (): Promise<void> => {
    if (ticking || lanesHeld) return;
    ticking = true;
    try {
      await withLanes(async () => {
        for (const host of hostsOf(config)) await checkHost(host);
      });
      await dailyCost();
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref();
  void tick();
  pi.on("session_shutdown", () => {
    shutDown = true;
    clearInterval(timer);
  });
}

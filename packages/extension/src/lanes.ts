import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { HostUnreachable, onHost, records } from "./host.ts";
import { readLaneConfig, type LaneConfig } from "./lane-config.ts";
import type { LaneRow } from "./views.ts";

const LAUNCH = fileURLToPath(new URL("./launch.ts", import.meta.url));
const REMOTE_WAIT_MS = 90_000;
const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

const hostsOf = (config: LaneConfig): string[] => ["local", ...Object.keys(config.hosts)];

async function fleet(config: LaneConfig, host: string, args: readonly string[]): Promise<string> {
  if (host === "local") return onHost(host, [process.execPath, LAUNCH, ...args], REMOTE_WAIT_MS);
  const script = 'root=${1:-$HOME/.fleet/app}; shift; exec "$root/bin/fleet" "$@"';
  const argv = ["sh", "-c", script, "fleet", config.roots[host] ?? "", ...args];
  return onHost(host, argv, REMOTE_WAIT_MS);
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

export function registerLanes(pi: ExtensionAPI, home: string): LaneStates | undefined {
  const config = readLaneConfig(home);
  if (config === undefined) return undefined;
  pi.registerTool({
    name: "lane",
    label: "Lane",
    description:
      "Starts, stops, or restarts a second mate's lane on its host. start also starts a lane that was stopped by hand or held for crashing; a mate that runs is left alone. stop holds the lane, so nothing restarts it until start; its conversation stays. restart starts the mate again on its own conversation. name \"all\" with restart restarts every lane that is not held, on every host: that restarts the fleet. Never touches cardd. board shows each lane's state.",
    parameters: LaneParams,
    execute: async (_id, { name, action }) => {
      if (name !== "all") return reply(await act(config, name, action));
      if (action !== "restart")
        throw new Error('lane "all" only restarts: name each lane to start or stop it');
      return reply((await restartAll(config)).join("\n"));
    },
  });
  keepRunning(pi, config);
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

const INTERVAL_MS = Number(process.env["FLEET_SUPERVISE_MS"]) || 60_000;

function keepRunning(pi: ExtensionAPI, config: LaneConfig): void {
  const unreachable = new Set<string>();
  let ticking = false;
  const tell = (lines: readonly string[], urgent: boolean): void => {
    if (lines.length === 0) return;
    const content = `[fleet] lanes: ${lines.join("; ")}`;
    pi.sendMessage(
      { customType: "fleet-lanes", content, display: true },
      urgent ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
    );
  };
  const checkHost = async (host: string): Promise<void> => {
    try {
      const out = await rows(config, host, ["up"]);
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
      tell([`${host} ${why}: ${error instanceof Error ? error.message : String(error)}`], true);
    }
  };
  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      for (const host of hostsOf(config)) await checkHost(host);
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref();
  void tick();
  pi.on("session_shutdown", () => {
    clearInterval(timer);
  });
}

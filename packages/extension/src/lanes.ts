// Main's tools for the rest of the fleet, and the loop that keeps it running (docs/setup.md).
// Each host runs its own `fleet` command (launch.ts) for the lanes configured there. Main reaches
// this host directly and every other host over its transport, so the same words work everywhere.
// cardd is not a lane: it runs under launchd and main never starts, stops, or checks it.
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { HostUnreachable, onHost, records } from "./host.ts";
import { readLaneConfig, type LaneConfig } from "./lane-config.ts";

const LAUNCH = fileURLToPath(new URL("./launch.ts", import.meta.url));
const REMOTE_WAIT_MS = 90_000;
const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** The host that runs this process is "local". Every other host is a key of the lane's `hosts`. */
const hostsOf = (config: LaneConfig): string[] => ["local", ...Object.keys(config.hosts)];

/** Runs `fleet <args>` on a host and returns what it printed. */
async function fleet(config: LaneConfig, host: string, args: readonly string[]): Promise<string> {
  if (host === "local") return onHost(host, [process.execPath, LAUNCH, ...args], REMOTE_WAIT_MS);
  // The checkout of this repository on that host. A non-interactive shell does not expand "~".
  const script = 'root=${1:-$HOME/.fleet/app}; shift; exec "$root/bin/fleet" "$@"';
  const argv = ["sh", "-c", script, "fleet", config.roots[host] ?? "", ...args];
  return onHost(host, argv, REMOTE_WAIT_MS);
}

/** The records that `fleet ... --json` printed. */
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

/** Every lane on every host. A host that cannot be reached is named, never skipped silently. */
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

const LaneParams = Type.Object({
  lane: Type.String({ minLength: 1, description: "The lane name, such as cleo" }),
});

export function registerLanes(pi: ExtensionAPI, home: string): void {
  const config = readLaneConfig(home);
  if (config === undefined) return;
  pi.registerTool({
    name: "lane_status",
    label: "Lane status",
    description:
      "Shows every second mate's lane on every host: running, down (should run, does not), or stopped (held on purpose).",
    parameters: Type.Object({}),
    execute: async () => {
      const lines: string[] = [];
      for (const host of hostsOf(config)) {
        try {
          for (const row of await rows(config, host, ["status"])) lines.push(describe(host, row));
        } catch (error) {
          lines.push(
            `${host}: cannot be reached - ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return reply(lines.length === 0 ? "No lanes are configured." : lines.join("\n"));
    },
  });
  pi.registerTool({
    name: "lane_start",
    label: "Start a lane",
    description:
      "Starts a lane's mate on its host, also when it was stopped by hand or held for crashing. A mate that runs is left alone.",
    parameters: LaneParams,
    execute: async (_id, params) => {
      const host = await hostOfLane(config, params.lane);
      const out = await rows(config, host, ["up", params.lane]);
      return reply(out.map((row) => describe(host, row)).join("\n"));
    },
  });
  pi.registerTool({
    name: "lane_stop",
    label: "Stop a lane",
    description:
      "Stops a lane's mate and holds it, so the loop that restarts dead mates leaves it alone until lane_start. Its conversation stays.",
    parameters: LaneParams,
    execute: async (_id, params) => {
      const host = await hostOfLane(config, params.lane);
      await fleet(config, host, ["stop", params.lane]);
      return reply(`${params.lane} (${host}): stopped`);
    },
  });
  pi.registerTool({
    name: "lane_restart",
    label: "Restart a lane",
    description:
      'Stops a lane\'s mate and starts it again on its own conversation. Use lane "all" to restart every lane that is not held, on every host: this restarts the fleet. Never touches cardd.',
    parameters: LaneParams,
    execute: async (_id, params) => {
      if (params.lane !== "all") {
        const host = await hostOfLane(config, params.lane);
        const out = await rows(config, host, ["restart", params.lane]);
        return reply(out.map((row) => describe(host, row)).join("\n"));
      }
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
      return reply(lines.length === 0 ? "No lanes are configured." : lines.join("\n"));
    },
  });
  keepRunning(pi, config);
}

const INTERVAL_MS = Number(process.env["FLEET_SUPERVISE_MS"]) || 60_000;

/**
 * Brings up every lane that does not run, now and then every minute: at start, after a mate dies,
 * and after a host reboots. A lane that is stopped on purpose stays stopped. A lane that keeps
 * crashing is held by `fleet up`, and the captain hears of it once. A host that cannot be reached
 * is reported once, until it answers again.
 */
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

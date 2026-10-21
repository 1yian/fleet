import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { HostUnreachable } from "./host.ts";
import { readLaneConfig, type LaneConfig } from "./lane-config.ts";
import { fleet, hostsOf, restartAll, withLanes } from "./lanes.ts";

const UPDATE_WAIT_MS = 900_000;
const RELAUNCH = fileURLToPath(new URL("./relaunch.ts", import.meta.url));

type HostReply =
  | { readonly state: "ready" | "unreachable" | "refused" | "failed"; readonly lines: string[] }
  | {
      readonly state: "updated";
      readonly lines: string[];
      readonly boardChanged: boolean;
      readonly carddChanged: boolean;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : "";
};
const short = (sha: string): string => sha.slice(0, 7);

function updatedLine(row: Record<string, unknown>): string {
  const from = str(row, "from");
  const to = str(row, "to");
  const commits = Number(row["commits"]);
  const lanes = Array.isArray(row["lanes"]) ? row["lanes"].map(String) : [];
  return [
    from === to
      ? `already current at ${short(to)}`
      : `updated ${short(from)}..${short(to)} (${String(commits)} commit${commits === 1 ? "" : "s"})`,
    ...(row["installed"] === true ? ["packages installed"] : []),
    "board built",
    lanes.length === 0 ? "no lane homes" : `lane homes moved: ${lanes.join(", ")}`,
  ].join("; ");
}

function parseReply(host: string, out: string): HostReply {
  const parsed: unknown = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
  if (!isRecord(parsed)) throw new Error(`fleet update on ${host} returned no JSON object`);
  const where = `${host} (${str(parsed, "root")})`;
  const state = str(parsed, "state");
  if (state === "ready") return { state, lines: [`${where}: ready`] };
  if (state === "refused") {
    const problems = Array.isArray(parsed["problems"]) ? parsed["problems"].map(String) : [];
    return { state, lines: problems.map((problem) => `${where}: ${problem}`) };
  }
  if (state === "failed") {
    const step = str(parsed, "step");
    const moved =
      str(parsed, "from") === str(parsed, "to") ? "" : ` after pulling ${short(str(parsed, "to"))}`;
    return { state, lines: [`${where}: ${step} failed${moved}: ${str(parsed, "error")}`] };
  }
  if (state === "updated")
    return {
      state,
      lines: [`${where}: ${updatedLine(parsed)}`],
      boardChanged: parsed["boardChanged"] === true,
      carddChanged: parsed["carddChanged"] === true,
    };
  throw new Error(`fleet update on ${host} answered an unknown state: ${state}`);
}

async function askHost(
  config: LaneConfig,
  host: string,
  args: readonly string[],
): Promise<HostReply> {
  try {
    return parseReply(host, await fleet(config, host, ["update", ...args], UPDATE_WAIT_MS));
  } catch (error) {
    const why = error instanceof HostUnreachable ? "cannot be reached" : "failed";
    const message = error instanceof Error ? error.message : String(error);
    return { state: "unreachable", lines: [`${host}: ${why} - ${message}`] };
  }
}

async function untilOneFails(config: LaneConfig): Promise<HostReply[]> {
  const replies: HostReply[] = [];
  for (const host of hostsOf(config)) {
    if (replies.some((reply) => reply.state !== "updated")) {
      replies.push({
        state: "failed",
        lines: [`${host}: not updated, because the update stopped`],
      });
      continue;
    }
    replies.push(await askHost(config, host, []));
  }
  return replies;
}

const bullets = (lines: readonly string[]): string => lines.map((line) => `- ${line}`).join("\n");

async function updateFleet(config: LaneConfig): Promise<{ ok: boolean; text: string }> {
  const checked: HostReply[] = [];
  for (const host of hostsOf(config)) checked.push(await askHost(config, host, ["--check"]));
  const blocking = checked.filter((reply) => reply.state !== "ready");
  if (blocking.length > 0)
    return {
      ok: false,
      text: `Fleet update stopped before any change: nothing was pulled, and no mate was restarted.\n${bullets(blocking.flatMap((reply) => reply.lines))}`,
    };
  const replies = await untilOneFails(config);
  const hostLines = bullets(replies.flatMap((reply) => reply.lines));
  if (replies.some((reply) => reply.state !== "updated"))
    return {
      ok: false,
      text: `Fleet update stopped: no mate was restarted, and main keeps running.\nHosts:\n${hostLines}`,
    };
  const updated = replies.flatMap((reply) => (reply.state === "updated" ? [reply] : []));
  const board = updated.some((reply) => reply.boardChanged)
    ? "Board: changed and rebuilt. cardd reads the board's files from disk, so it needs no restart for the board."
    : "Board: unchanged.";
  const cardd = updated.some((reply) => reply.carddChanged)
    ? "cardd: its code changed. It keeps running the old code until the captain updates its checkout and restarts its launchd job (docs/setup.md section 2). The update never touches it."
    : "cardd: its code did not change, so it needs no restart.";
  const lanes = await restartAll(config);
  return {
    ok: true,
    text: `Fleet updated.\nHosts:\n${hostLines}\nLanes:\n${bullets(lanes)}\n${board}\n${cardd}`,
  };
}

const ownPane = (): string | undefined => {
  const pane = process.env["HERDR_PANE_ID"];
  return pane === undefined || pane === "" ? undefined : pane;
};

const mainLine = (): string =>
  ownPane() === undefined
    ? "Main: not in a herdr pane, so it cannot restart itself. Restart it with `pi -c` in its home."
    : "Main: restarts on its own conversation when this turn ends.";

function restartMain(ctx: ExtensionContext): void {
  const pane = ownPane();
  if (pane === undefined) return;
  const args = process.argv.slice(2).filter((arg) => arg !== "-c" && arg !== "--continue");
  const helper = spawn(
    process.execPath,
    [RELAUNCH, String(process.pid), pane, process.cwd(), ...args],
    { detached: true, stdio: "ignore" },
  );
  helper.unref();
  ctx.shutdown();
}

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function registerUpdate(pi: ExtensionAPI, home: string): void {
  const config = readLaneConfig(home);
  if (config === undefined) return;
  let restartPending = false;
  let running = false;
  const run = async (): Promise<{ ok: boolean; text: string }> => {
    if (running) throw new Error("the fleet update is already running");
    running = true;
    try {
      const result = await withLanes(() => updateFleet(config));
      return result.ok ? { ok: true, text: `${result.text}\n${mainLine()}` } : result;
    } finally {
      running = false;
    }
  };
  pi.registerTool({
    name: "update_fleet",
    label: "Update fleet",
    description:
      "Updates the fleet to the latest origin/main, as /updatefleet does: checks every host first and stops before any change when a checkout or lane home has uncommitted changes or its own commits, or a host cannot be reached. Then it pulls each host's checkout, installs packages when the lockfile changed, builds the board, moves every lane home to the new commit, restarts every lane that is not held, and restarts main on its conversation when this turn ends. Never touches cardd. Use it only when the captain asks to update the fleet.",
    parameters: Type.Object({}),
    execute: async () => {
      const result = await run();
      if (!result.ok) throw new Error(result.text);
      restartPending = ownPane() !== undefined;
      return reply(result.text);
    },
  });
  pi.registerCommand("updatefleet", {
    description:
      "Update the fleet to the latest origin/main on every host, restart every lane, then restart main on its conversation.",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify("Updating the fleet on every host...", "info");
      const result = await run().catch((error: unknown) => ({
        ok: false,
        text: error instanceof Error ? error.message : String(error),
      }));
      restartPending = result.ok && ownPane() !== undefined;
      pi.sendMessage(
        { customType: "fleet-update", content: `[fleet] update: ${result.text}`, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!restartPending) return;
    restartPending = false;
    restartMain(ctx);
  });
}

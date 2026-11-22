import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { check, VersionSchema, type Version } from "@fleet/protocol";
import Type from "typebox";
import { arrangeOn, tagWorkers } from "./arrange.ts";
import { fleetHostName } from "@fleet/protocol/route";
import { HostUnreachable, ownHostName } from "./host.ts";
import { LANE_FILE, readLaneConfig, type CarddConfig, type LaneConfig } from "./lane-config.ts";
import { fleet, hostsOf, runningMates, soleHosts, withLanes } from "./lanes.ts";
import type { Link } from "./link.ts";
import {
  maintenanceReport,
  ownPane,
  relaunchSelf,
  requestAndAwait,
  type ReloadScope,
} from "./maintenance.ts";

const UPDATE_WAIT_MS = 900_000;
const MAINTENANCE_WAIT_MS = Number(process.env["FLEET_MAINTENANCE_WAIT_MS"]) || 30_000;
const CARDD_WAIT_MS = Number(process.env["FLEET_CARDD_WAIT_MS"]) || 60_000;
const VERSION_TIMEOUT_MS = 2_000;

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
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const short = (sha: string): string => sha.slice(0, 7);

function pulledParts(row: Record<string, unknown>): string[] {
  const from = str(row, "from");
  const to = str(row, "to");
  const commits = Number(row["commits"]);
  return [
    from === to
      ? `already current at ${short(to)}`
      : `updated ${short(from)}..${short(to)} (${String(commits)} commit${commits === 1 ? "" : "s"})`,
    ...(row["installed"] === true ? ["packages installed"] : []),
    "board built",
  ];
}

function updatedLine(row: Record<string, unknown>): string {
  const lanes = Array.isArray(row["lanes"]) ? row["lanes"].map(String) : [];
  const dependencies = Array.isArray(row["dependencies"]) ? row["dependencies"].map(String) : [];
  return [
    ...pulledParts(row),
    lanes.length === 0 ? "no lane homes" : `lane homes moved: ${lanes.join(", ")}`,
    ...(dependencies.length === 0 ? [] : [`dependencies: ${dependencies.join(", ")}`]),
  ].join("; ");
}

interface Parsed {
  readonly where: string;
  readonly row: Record<string, unknown>;
}

interface Outcome {
  readonly ok: boolean;
  readonly lines: string[];
}

function parseRow(host: string, out: string): Parsed {
  const parsed: unknown = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
  if (!isRecord(parsed)) throw new Error(`fleet on ${host} returned no JSON object`);
  return { where: str(parsed, "root"), row: parsed };
}

function unfinished(where: string, row: Record<string, unknown>): HostReply | undefined {
  const state = str(row, "state");
  if (state === "ready") return { state, lines: [`${where}: ready`] };
  if (state === "refused") {
    const problems = Array.isArray(row["problems"]) ? row["problems"].map(String) : [];
    return { state, lines: problems.map((problem) => `${where}: ${problem}`) };
  }
  if (state === "failed") {
    const step = str(row, "step");
    const moved =
      str(row, "from") === str(row, "to") ? "" : ` after pulling ${short(str(row, "to"))}`;
    return { state, lines: [`${where}: ${step} failed${moved}: ${str(row, "error")}`] };
  }
  if (state === "updated") return undefined;
  throw new Error(`fleet on ${where} answered an unknown state: ${state}`);
}

function parseReply(host: string, out: string): HostReply {
  const { where: root, row } = parseRow(host, out);
  const where = `${host} (${root})`;
  return (
    unfinished(where, row) ?? {
      state: "updated",
      lines: [`${where}: ${updatedLine(row)}`],
      boardChanged: row["boardChanged"] === true,
      carddChanged: row["carddChanged"] === true,
    }
  );
}

const unreachable = (where: string, error: unknown): HostReply => {
  const why = error instanceof HostUnreachable ? "cannot be reached" : "failed";
  const message = error instanceof Error ? error.message : String(error);
  return { state: "unreachable", lines: [`${where}: ${why} - ${message}`] };
};

async function askHost(
  config: LaneConfig,
  host: string,
  args: readonly string[],
): Promise<HostReply> {
  try {
    return parseReply(host, await fleet(config, host, ["update", ...args], UPDATE_WAIT_MS));
  } catch (error) {
    return unreachable(host, error);
  }
}

type CarddReply =
  | HostReply
  | {
      readonly state: "pulled";
      readonly where: string;
      readonly parts: string[];
      readonly to: string;
      readonly restart?: { readonly backup: string; readonly schema: number };
    };

async function askCardd(
  config: LaneConfig,
  cardd: CarddConfig,
  args: readonly string[],
): Promise<CarddReply> {
  const label = `${cardd.host} cardd`;
  const command = ["cardd", "--root", cardd.root, "--db", cardd.db, ...args];
  try {
    const { where: root, row } = parseRow(
      label,
      await fleet(config, cardd.host, command, UPDATE_WAIT_MS),
    );
    const where = `${label} (${root})`;
    const done = unfinished(where, row);
    if (done !== undefined) return done;
    const restart = isRecord(row["restart"]) ? row["restart"] : undefined;
    return {
      state: "pulled",
      where,
      parts: pulledParts(row),
      to: str(row, "to"),
      ...(restart === undefined
        ? {}
        : { restart: { backup: str(restart, "backup"), schema: Number(restart["schema"]) } }),
    };
  } catch (error) {
    return unreachable(label, error);
  }
}

async function carddVersion(url: string): Promise<Version | undefined> {
  const address = url.replace(/^ws/, "http").replace(/\/session$/, "/api/version");
  try {
    const response = await fetch(address, { signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
    return response.ok ? check(VersionSchema, await response.json()) : undefined;
  } catch {
    return undefined;
  }
}

async function answersOn(url: string, commit: string): Promise<Version | undefined> {
  const deadline = Date.now() + CARDD_WAIT_MS;
  for (;;) {
    const version = await carddVersion(url);
    if (version?.commit === commit) return version;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function updateCardd(config: LaneConfig, cardd: CarddConfig): Promise<Outcome> {
  const running = (await carddVersion(config.url))?.commit ?? undefined;
  const reply = await askCardd(config, cardd, [
    ...(running === undefined ? [] : ["--running", running]),
    "--restart",
    JSON.stringify(cardd.restart),
  ]);
  if (reply.state !== "pulled") return { ok: false, lines: reply.lines };
  const line = (ok: boolean, ...more: string[]): Outcome => ({
    ok,
    lines: [`${reply.where}: ${[...reply.parts, ...more].join("; ")}`],
  });
  if (reply.restart === undefined)
    return line(true, "its code did not change, so it was not restarted");
  const backedUp = `database backed up to ${reply.restart.backup}`;
  const version = await answersOn(config.url, reply.to);
  if (version === undefined)
    return line(
      false,
      backedUp,
      `restarted, but it did not answer on ${short(reply.to)} within ${String(CARDD_WAIT_MS / 1000)} s`,
    );
  const schema =
    version.schema === reply.restart.schema
      ? `schema ${String(version.schema)}, no migrations`
      : `schema ${String(reply.restart.schema)} -> ${String(version.schema)}`;
  return line(true, backedUp, `restarted and answers on ${short(reply.to)}`, schema);
}

interface Target {
  readonly hosts: readonly string[];
  readonly skipped: readonly string[];
  readonly scoped: boolean;
}

function chooseTarget(config: LaneConfig, requested: readonly string[] | undefined): Target {
  const known = hostsOf(config);
  if (requested === undefined) return { hosts: known, skipped: [], scoped: false };
  if (requested.length === 0 || requested.some((name) => name.trim() === ""))
    throw new Error("the host list must name at least one host, and no name may be empty");
  const unknown = requested.filter((name) => !known.includes(name));
  if (unknown.length > 0)
    throw new Error(
      `unknown host ${unknown.map((name) => JSON.stringify(name)).join(", ")}: choose from ${known.join(", ")}`,
    );
  const hosts = known.filter((name) => requested.includes(name));
  if (!hosts.includes("local"))
    throw new Error(
      "main runs on local, so a host list must include local: main restarts and reloads on its own host",
    );
  if (config.cardd !== undefined && !hosts.includes(config.cardd.host))
    throw new Error(
      `cardd runs on ${config.cardd.host}, so a host list must include ${config.cardd.host}: the update restarts cardd there`,
    );
  return { hosts, skipped: known.filter((name) => !hosts.includes(name)), scoped: true };
}

const notTargeted = (target: Target): string[] =>
  target.skipped.map((host) => `${host}: not targeted, not checked`);

async function untilOneFails(config: LaneConfig, hosts: readonly string[]): Promise<HostReply[]> {
  const replies: HostReply[] = [];
  for (const host of hosts) {
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

async function checkCardd(config: LaneConfig, cardd: CarddConfig): Promise<HostReply> {
  const reply = await askCardd(config, cardd, ["--check"]);
  return reply.state === "pulled"
    ? { state: "failed", lines: [`${reply.where}: not checked`] }
    : reply;
}

async function updateFleet(
  config: LaneConfig,
  link: Link,
  target: Target,
): Promise<{ ok: boolean; text: string }> {
  const checked: HostReply[] = [];
  for (const host of target.hosts) checked.push(await askHost(config, host, ["--check"]));
  if (config.cardd !== undefined) checked.push(await checkCardd(config, config.cardd));
  const blocking = checked.filter((reply) => reply.state !== "ready");
  if (blocking.length > 0)
    return {
      ok: false,
      text: `Fleet update stopped before any change: nothing was pulled, and no mate was restarted.\n${bullets([...blocking.flatMap((reply) => reply.lines), ...notTargeted(target)])}`,
    };
  const replies = await untilOneFails(config, target.hosts);
  if (replies.some((reply) => reply.state !== "updated"))
    return {
      ok: false,
      text: `Fleet update stopped: no mate was restarted, and main keeps running.\nHosts:\n${bullets([...replies.flatMap((reply) => reply.lines), ...notTargeted(target)])}`,
    };
  const carddStep: Outcome | undefined =
    config.cardd === undefined ? undefined : await updateCardd(config, config.cardd);
  const hostLines = bullets([
    ...[...replies, ...(carddStep === undefined ? [] : [carddStep])].flatMap((each) => each.lines),
    ...notTargeted(target),
  ]);
  if (carddStep?.ok === false)
    return {
      ok: false,
      text: `Fleet update stopped: cardd does not run the new code, so no mate was restarted, and main keeps running.\nHosts:\n${hostLines}`,
    };
  const placement: Placement = await runningMates(config, target.hosts).then(
    (running) => ({ running }),
    (error: unknown) => ({ failure: messageOf(error) }),
  );
  const tags = await tagWorkersOn(link, target.hosts, placement).catch((error: unknown) => [
    `Worker metadata not refreshed: ${messageOf(error)}`,
  ]);
  const lanes = await reloadLines(link, target, placement);
  const sidebars = await arrangeAll(config, target.hosts);
  return {
    ok: true,
    text: [
      "Fleet updated.",
      `Hosts:\n${hostLines}`,
      `Reloads at each safe point (pending is not completed):\n${lanes.join("\n")}`,
      `Sidebars:\n${bullets([...tags, ...sidebars])}`,
      ...changeLines(replies, carddStep !== undefined),
    ].join("\n"),
  };
}

type Placement = { readonly running: ReadonlyMap<string, string[]> } | { readonly failure: string };

async function reloadLines(link: Link, target: Target, placement: Placement): Promise<string[]> {
  let scope: ReloadScope | undefined;
  if (target.scoped) {
    if ("failure" in placement)
      return [
        `Unable to reload: mates on the selected hosts could not be identified (${placement.failure}), so nothing was enrolled`,
      ];
    scope = {
      hosts: target.hosts.flatMap((host) =>
        host === "local" ? ["local", fleetHostName(), ownHostName()] : [host],
      ),
      mates: [...placement.running.keys()],
    };
  }
  return requestAndAwait(link, scope, randomUUID(), MAINTENANCE_WAIT_MS).then(
    maintenanceReport,
    (error: unknown) => [`Unable to reload: ${messageOf(error)}`],
  );
}

async function arrangeAll(config: LaneConfig, hosts: readonly string[]): Promise<string[]> {
  const lines: string[] = [];
  for (const host of hosts) {
    try {
      await arrangeOn(host, config.roots[host]);
      lines.push(`${host}: ordered`);
    } catch (error) {
      lines.push(
        `${host}: not ordered - ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return lines;
}

async function tagWorkersOn(
  link: Link,
  hosts: readonly string[],
  placement: Placement,
): Promise<string[]> {
  const cards = await link.call("board", {});
  const laneOfCard = new Map(cards.map((card) => [card.id, card.lane]));
  const mates = "running" in placement ? soleHosts(placement.running) : new Map<string, string>();
  for (const host of hosts) await tagWorkers(host, laneOfCard, mates).catch(() => undefined);
  return "failure" in placement ? [`Mate placement unchanged: ${placement.failure}`] : [];
}

function changeLines(replies: readonly HostReply[], carddUpdated: boolean): string[] {
  const updated = replies.flatMap((reply) => (reply.state === "updated" ? [reply] : []));
  const board = updated.some((reply) => reply.boardChanged)
    ? "Board: changed and rebuilt. cardd reads the board's files from disk, so it needs no restart for the board."
    : "Board: unchanged.";
  if (carddUpdated) return [board];
  return [
    board,
    updated.some((reply) => reply.carddChanged)
      ? 'cardd: its code changed, but config/lane.json has no "cardd" entry, so the update did not restart it (docs/setup.md section 2).'
      : "cardd: its code did not change, so it needs no restart.",
  ];
}

const mainLine = (): string =>
  ownPane() === undefined
    ? "Main: not in a herdr pane, so it cannot restart itself. Restart it with `pi -c` in its home."
    : "Main: restarts on its own conversation when this turn ends.";

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function registerUpdate(pi: ExtensionAPI, home: string, link: Link): void {
  if (readLaneConfig(home) === undefined) return;
  let restartPending = false;
  let running = false;
  const run = async (hosts?: readonly string[]): Promise<{ ok: boolean; text: string }> => {
    if (running) throw new Error("the fleet update is already running");
    running = true;
    try {
      const config = readLaneConfig(home);
      if (config === undefined) throw new Error(`${LANE_FILE} in ${home} cannot be read`);
      const target = chooseTarget(config, hosts);
      const result = await withLanes(target.hosts, () => updateFleet(config, link, target));
      return result.ok ? { ok: true, text: `${result.text}\n${mainLine()}` } : result;
    } finally {
      running = false;
    }
  };
  pi.registerTool({
    name: "update_fleet",
    label: "Update fleet",
    description:
      "Updates the fleet to the latest origin/main, as /updatefleet does: checks every host first and stops before any change when a checkout or lane home has uncommitted changes or its own commits, or a host cannot be reached. Then it pulls each host's checkout, installs packages when the lockfile changed, builds the board, moves every lane home to the new commit, updates Pi, pi-tiers, and the 1yian/no-mistakes fork on each host to their latest remote (never restarting a no-mistakes daemon, never touching other Pi packages, and reporting a pinned pi-tiers, or a Pi that another package manager owns, as not updated), then updates cardd's checkout when config/lane.json has a cardd entry: when cardd's code changed, it backs up cardd's database, restarts cardd, and waits until cardd answers on the new code, and it stops without restarting any lane when cardd does not. Then it requests safe-point reloads of connected workers and second mates without interrupting their turns or long jobs, preserves stopped lanes and task waits, reports pending versus completed requests, reorders every host's herdr sidebar, and restarts main on its conversation when this turn ends. Main runs it right after every merged fleet change, without asking. With hosts, it updates only those hosts: the list is resolved once, an empty or unknown name is refused before any host is contacted, and no alias is inferred. A host that is not listed is never contacted, not even for the first check, and the report names it as not targeted, not checked. The list must include local, where main runs, and the host of cardd. Reload requests, worker metadata, and the sidebar then cover only workers and second mates that are positively on a listed host, and the update refuses to enroll anyone when cardd cannot scope reloads. Without hosts, every host takes part.",
    parameters: Type.Object({
      hosts: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          description:
            'Host names from config/lane.json, "local" for main\'s own host. Omit to update every host',
        }),
      ),
    }),
    execute: async (_id, { hosts }) => {
      const result = await run(hosts);
      if (!result.ok) throw new Error(result.text);
      restartPending = ownPane() !== undefined;
      return reply(result.text);
    },
  });
  pi.registerCommand("updatefleet", {
    description:
      "Update the fleet to the latest origin/main on every host and cardd, or only on the hosts named after the command (/updatefleet local p620; local and cardd's host are required, and other hosts are never contacted), update Pi, pi-tiers, and the no-mistakes fork on every host, restart cardd when its code changed, request safe-point reloads of workers and second mates, arrange every host's herdr sidebar, then restart main on its conversation.",
    handler: async (args, ctx) => {
      const hosts = args.split(/[\s,]+/).filter((name) => name !== "");
      const named = hosts.length === 0 ? undefined : hosts;
      if (ctx.hasUI)
        ctx.ui.notify(`Updating the fleet on ${named?.join(", ") ?? "every host"}...`, "info");
      const result = await run(named).catch((error: unknown) => ({
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
    const pane = ownPane();
    if (pane !== undefined) relaunchSelf(ctx, pane);
  });
}

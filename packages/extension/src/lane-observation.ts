import { realpathSync } from "node:fs";
import { field, HostUnread, isPi, laneHerdr, records } from "./host.ts";
import { isRecord } from "./lane-config.ts";
import { isWorkerWorkspace, legacyMatePrefix, mateTitle } from "./titles.ts";

const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

async function observeList(
  noun: string,
  args: readonly string[],
  keys: readonly string[],
  deadline?: number,
) {
  const result = await laneHerdr([noun, "list", ...args], "observe", deadline);
  const list = result[`${noun}s`];
  const rows = records(list);
  if (
    !Array.isArray(list) ||
    rows.length !== list.length ||
    rows.some((row) => keys.some((key) => typeof row[key] !== "string" || row[key] === ""))
  )
    throw new HostUnread(`herdr returned an incomplete ${noun} list`);
  return rows;
}

async function panesOf(workspace: string, count: unknown, deadline?: number) {
  const rows = await observeList("pane", ["--workspace", workspace], ["pane_id"], deadline);
  const panes = rows.map((row) => ({ pane: String(row["pane_id"]), cwd: field(row, "cwd") }));
  if (
    panes.length === 0 ||
    panes.length !== count ||
    new Set(panes.map(({ pane }) => pane)).size !== panes.length ||
    rows.some((row) => row["workspace_id"] !== workspace)
  )
    throw new HostUnread(`herdr returned an incomplete pane list for ${workspace}`);
  return panes;
}

type LaneMatch =
  | { workspace: string; state: "matched" | "running" }
  | { workspace: string; state: "idle"; pane: string };

type Purpose = "liveness" | "placement" | "close" | "restart-held";

export const idlePaneOf = (match: LaneMatch | undefined): string | undefined =>
  match?.state === "idle" ? match.pane : undefined;

async function legacyMatches(
  rows: readonly Record<string, unknown>[],
  home: string,
  closing: boolean,
  deadline: number | undefined,
  log: string[],
) {
  const verified: { workspace: string; pane: string }[] = [];
  for (const row of rows) {
    const workspace = String(row["workspace_id"]);
    const panes = await panesOf(workspace, row["pane_count"], deadline);
    const [first] = panes;
    if (first === undefined) throw new HostUnread(`herdr returned no pane for ${workspace}`);
    if (!closing && panes.length !== 1)
      throw new HostUnread(`cannot verify the root pane for split workspace ${workspace}`);
    const cwd = requiredCwd(first.cwd, workspace);
    if (canonical(cwd) === canonical(home)) {
      verified.push({ workspace, pane: first.pane });
      log.push(`legacy ${workspace} ${first.pane} ${membership(panes)}`);
    }
  }
  if (verified.length > 1)
    throw new HostUnread(
      `herdr lists ${String(verified.length)} legacy workspaces rooted in ${home}`,
    );
  return verified[0];
}

async function findLegacy(
  rows: readonly Record<string, unknown>[],
  home: string,
  purpose: Purpose,
  deadline: number | undefined,
  log: string[],
): Promise<LaneMatch | undefined> {
  const only = await legacyMatches(
    rows,
    home,
    purpose === "close" || purpose === "restart-held",
    deadline,
    log,
  );
  if (only === undefined) return undefined;
  if (purpose === "close") return { workspace: only.workspace, state: "matched" };
  const state = await lanePaneState(only.pane, deadline);
  log.push(`legacy-state ${only.pane} ${state}`);
  if (purpose === "restart-held")
    return state !== "down" ? { workspace: only.workspace, state: "running" } : undefined;
  if (purpose === "placement" && state !== "pi") return undefined;
  if (state !== "down") return { workspace: only.workspace, state: "running" };
  return { workspace: only.workspace, state: "idle", pane: only.pane };
}

const membership = (panes: readonly { pane: string }[]): string =>
  panes
    .map(({ pane }) => pane)
    .sort()
    .join(",");

const matchesHome = (cwd: string | undefined, home: string): boolean =>
  cwd !== undefined && cwd !== "" && canonical(cwd) === canonical(home);

async function inspectSplit(
  workspace: string,
  panes: Awaited<ReturnType<typeof panesOf>>,
  home: string,
  purpose: Purpose,
  deadline: number | undefined,
  log: string[],
): Promise<LaneMatch> {
  if (purpose === "placement")
    throw new HostUnread(`cannot verify the root pane for split workspace ${workspace}`);
  for (const { pane, cwd } of panes) {
    if (matchesHome(cwd, home) && (await lanePaneState(pane, deadline)) === "pi") {
      log.push(`split-pi ${workspace} ${pane} ${membership(panes)}`);
      return { workspace, state: "running" };
    }
  }
  throw new HostUnread(`no Pi observed in the lane home for split workspace ${workspace}`);
}

async function findCurrent(
  row: Record<string, unknown> | undefined,
  home: string,
  purpose: Purpose,
  deadline: number | undefined,
  log: string[],
): Promise<LaneMatch | undefined> {
  if (row === undefined) return undefined;
  const workspace = String(row["workspace_id"]);
  if (purpose === "close") return { workspace, state: "matched" };
  const panes = await panesOf(workspace, row["pane_count"], deadline);
  const [first] = panes;
  if (first === undefined) throw new HostUnread(`herdr returned no pane for ${workspace}`);
  if (panes.length !== 1) return inspectSplit(workspace, panes, home, purpose, deadline, log);
  if (purpose === "placement" && !matchesHome(requiredCwd(first.cwd, workspace), home)) {
    log.push(`foreign ${workspace} ${first.pane}`);
    return undefined;
  }
  const state = await lanePaneState(first.pane, deadline);
  log.push(`single ${workspace} ${first.pane} ${state}`);
  if (purpose === "placement" && state !== "pi") return undefined;
  return state !== "down"
    ? { workspace, state: "running" }
    : { workspace, state: "idle", pane: first.pane };
}

function requiredCwd(cwd: string | undefined, workspace: string): string {
  if (cwd === undefined || cwd === "")
    throw new HostUnread(`herdr returned no root pane cwd for ${workspace}`);
  return cwd;
}

type Rows = readonly Record<string, unknown>[];

const sameRows = (before: Rows, after: Rows): boolean =>
  before.length === after.length &&
  before.every((row, index) => {
    const next = after[index];
    return (
      row["workspace_id"] === next?.["workspace_id"] && row["pane_count"] === next?.["pane_count"]
    );
  });

export async function workspaceOf(
  info: { lane: string; home: string },
  purpose: Purpose,
  deadline?: number,
): Promise<LaneMatch | undefined> {
  const title = mateTitle(info.lane);
  const legacyTitle = `${legacyMatePrefix}${info.lane}`;
  const read = async () => {
    const listed = await observeList("workspace", [], ["workspace_id", "label"], deadline);
    const current = listed.filter((row) => row["label"] === title);
    if (current.length > 1)
      throw new HostUnread(`herdr lists ${String(current.length)} workspaces titled ${title}`);
    return {
      current,
      legacy: listed.filter((row) => row["label"] === legacyTitle && !isWorkerWorkspace(row)),
    };
  };
  const changed = () => new HostUnread(`herdr workspace candidates changed for ${info.lane}`);
  type Listed = Awaited<ReturnType<typeof read>>;
  const decide = async (rows: Listed, before?: Listed) => {
    const log: string[] = [];
    const current = await findCurrent(rows.current[0], info.home, purpose, deadline, log);
    if (current !== undefined) {
      log.push(`current ${current.workspace} ${String(rows.current[0]?.["pane_count"])}`);
      return { found: current, log };
    }
    if (
      before !== undefined &&
      (!sameRows(before.current, rows.current) || !sameRows(before.legacy, rows.legacy))
    )
      throw changed();
    return { found: await findLegacy(rows.legacy, info.home, purpose, deadline, log), log };
  };
  const first = await read();
  const fresh = await read();
  if (first.current.length > 0 && !sameRows(first.current, fresh.current)) throw changed();
  const decided = await decide(fresh, first);
  const again = await decide(await read(), fresh);
  if (JSON.stringify(decided) !== JSON.stringify(again)) throw changed();
  return decided.found;
}

function completeLaneProcess(row: Record<string, unknown>): boolean {
  const argv = row["argv"];
  return (
    Number.isInteger(row["pid"]) &&
    typeof row["name"] === "string" &&
    Array.isArray(argv) &&
    argv.every((arg) => typeof arg === "string")
  );
}

export async function lanePaneState(
  pane: string,
  deadline?: number,
): Promise<"pi" | "busy" | "down"> {
  const reply = await laneHerdr(["pane", "process-info", "--pane", pane], "observe", deadline);
  const info = reply["process_info"];
  if (!isRecord(info)) throw new HostUnread(`herdr returned no process info for pane ${pane}`);
  const processes = completeProcesses(info["foreground_processes"], pane);
  if (processes.some(isPi)) return "pi";
  const shell = info["shell_pid"];
  const group = info["foreground_process_group_id"];
  if (!Number.isInteger(shell) || !Number.isInteger(group))
    throw new HostUnread(`herdr returned no shell or foreground group for pane ${pane}`);
  if (shell !== group && processes.length === 0)
    throw new HostUnread(`herdr returned a foreground group without processes for pane ${pane}`);
  return shell === group ? "down" : "busy";
}

function completeProcesses(entries: unknown, pane: string) {
  const processes = records(entries);
  if (
    !Array.isArray(entries) ||
    processes.length !== entries.length ||
    processes.some((row) => !completeLaneProcess(row))
  )
    throw new HostUnread(`herdr returned an incomplete process list for pane ${pane}`);
  return processes;
}

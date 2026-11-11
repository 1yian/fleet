import { field, herdr, isLocal, NoTransport, records } from "../host.ts";
import { filesSettings } from "../lane-config.ts";
import { mateTitle } from "../titles.ts";
import type { World } from "./world.ts";

export const FILES_TAB = "Files";

export interface Mate {
  readonly host: string;
  readonly lane: string;
  readonly agent: string;
  readonly status: string;
}

async function agentIn(host: string, workspace: string, lane: string): Promise<Mate> {
  const agents = records((await herdr(host, ["agent", "list"]))["agents"]).filter(
    (each) => each["workspace_id"] === workspace,
  );
  const tabs = records((await herdr(host, ["tab", "list", "--workspace", workspace]))["tabs"]);
  const filesTab = field(
    tabs.find((tab) => tab["label"] === FILES_TAB),
    "tab_id",
  );
  const agent = agents.find((each) => each["tab_id"] !== filesTab);
  const pane = field(agent, "pane_id");
  if (agent === undefined || pane === undefined)
    throw new Error(`the mate of lane ${lane} has no agent running on ${host}`);
  return { host, lane, agent: pane, status: String(agent["agent_status"]) };
}

export async function ownMate(world: World): Promise<Mate> {
  const workspace = process.env["HERDR_WORKSPACE_ID"];
  if (workspace === undefined)
    throw new Error("this is not a herdr pane, so there is no mate to reach");
  return agentIn(world.host, workspace, world.lane.lane);
}

export type MainRoute =
  | { readonly kind: "pane"; readonly host: string }
  | { readonly kind: "board"; readonly why: string };

function reachable(host: string): boolean {
  try {
    isLocal(host);
    return true;
  } catch (error) {
    if (error instanceof NoTransport) return false;
    throw error;
  }
}

export function routeToMain(world: World): MainRoute {
  const host =
    filesSettings(world.lane).main ?? (world.lane.lane === "main" ? world.host : undefined);
  if (host === undefined)
    return {
      kind: "board",
      why: 'this lane does not say where main runs (config/lane.json, "files": {"main": <host>})',
    };
  if (reachable(host)) return { kind: "pane", host };
  return { kind: "board", why: `this host has no transport to ${host}, where main runs` };
}

export async function mainMate(host: string): Promise<Mate> {
  const spaces = records((await herdr(host, ["workspace", "list"]))["workspaces"]);
  const workspace = field(
    spaces.find((each) => each["label"] === mateTitle("main")),
    "workspace_id",
  );
  if (workspace === undefined) throw new Error(`main has no workspace on ${host}`);
  return agentIn(host, workspace, "main");
}

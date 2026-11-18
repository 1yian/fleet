import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { field, herdr, piRunning, records } from "./host.ts";
import { isRecord, readLaneConfig } from "./lane-config.ts";

export const mateTitle = (lane: string): string =>
  lane === "main" ? "1stmate" : `2ndmate-${lane}`;

export const legacyMatePrefix = "fleet-";

export function isWorkerWorkspace(row: Record<string, unknown>): boolean {
  const tokens = row["tokens"];
  return isRecord(tokens) && (field(tokens, "lane") || field(tokens, "card")) !== undefined;
}

export async function liveLegacyMate(workspace: string, lane: string): Promise<boolean> {
  const panes = await herdr("local", ["pane", "list", "--workspace", workspace]);
  const root = records(panes["panes"])[0];
  const pane = field(root, "pane_id");
  const cwd = field(root, "cwd");
  if (pane === undefined || cwd === undefined) return false;
  try {
    if (readLaneConfig(cwd)?.lane !== lane) return false;
  } catch {
    return false;
  }
  return piRunning("local", pane);
}

const holdsTerminal = (): boolean => process.stdin.isTTY && process.stdout.isTTY;

export async function titleMate(pi: ExtensionAPI, lane: string): Promise<void> {
  const title = mateTitle(lane);
  if (pi.getSessionName() !== title) pi.setSessionName(title);
  const workspace = process.env["HERDR_WORKSPACE_ID"];
  if (workspace !== undefined && holdsTerminal())
    await herdr("local", ["workspace", "rename", workspace, title]);
}

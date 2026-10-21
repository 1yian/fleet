import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { herdr } from "./host.ts";

export const mateTitle = (lane: string): string =>
  lane === "main" ? "1stmate" : `2ndmate-${lane}`;

const formerTitle = (lane: string): string => `fleet-${lane}`;

export const isMateWorkspace = (label: unknown, lane: string): boolean =>
  label === mateTitle(lane) || label === formerTitle(lane);

export async function titleMate(pi: ExtensionAPI, lane: string): Promise<void> {
  const title = mateTitle(lane);
  if (pi.getSessionName() !== title) pi.setSessionName(title);
  const workspace = process.env["HERDR_WORKSPACE_ID"];
  if (workspace !== undefined) await herdr("local", ["workspace", "rename", workspace, title]);
}

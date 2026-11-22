import type { Handoff } from "../shared/protocol.js";
import { daemon } from "./client.js";
import { ringHerdr } from "./lanes.js";

export async function waitForHandoff(lane: string, current: Handoff | null) {
  if (current?.status !== "open") return { handoff: current?.status ?? "none open" };
  let handoff = current;
  while (handoff.status === "open" && Date.now() < current.expiresAt) {
    handoff = await daemon.waitHandoff(lane, current.id, 30);
  }
  return {
    handoff: handoff.status,
    reason: handoff.reason,
    help: [
      handoff.status === "done"
        ? "The captain finished; continue with `fleet-browser snapshot -i`"
        : "No answer; retry or stop the task",
    ],
  };
}

export async function askCaptain(lane: string, reason: string, waitSeconds: number, target?: string) {
  const before = await daemon.currentHandoff(lane);
  const opened = await daemon.openHandoff(lane, reason, waitSeconds, target);
  if (opened.id !== before?.id) ringHerdr(`Browser needs you: ${lane}`, reason);
  return waitForHandoff(lane, opened);
}

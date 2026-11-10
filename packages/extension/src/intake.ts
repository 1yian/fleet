import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleetEntryId } from "./inbox.ts";
import type { Link } from "./link.ts";

const UNFINISHED: ReadonlySet<unknown> = new Set(["error", "aborted"]);

export function registerIntake(pi: ExtensionAPI, link: Link, loaded: readonly number[]): void {
  const inRun = new Set<number>(loaded);
  const unanswered = new Set<number>(loaded);
  let lastStop: unknown;
  pi.on("message_end", (event) => {
    const id = fleetEntryId(event.message);
    if (id !== undefined) {
      inRun.add(id);
      unanswered.add(id);
    }
    if (event.message.role !== "assistant") return;
    lastStop = event.message.stopReason;
    if (UNFINISHED.has(lastStop)) return;
    for (const entry of unanswered) link.read(entry);
    unanswered.clear();
  });
  pi.on("agent_settled", (event) => {
    const taken = !event.aborted && !UNFINISHED.has(lastStop);
    if (taken) for (const id of inRun) link.ack(id);
    inRun.clear();
    unanswered.clear();
    lastStop = undefined;
  });
}

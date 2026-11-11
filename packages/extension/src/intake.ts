import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleetEntryId } from "./inbox.ts";
import type { Link } from "./link.ts";

const UNFINISHED: ReadonlySet<unknown> = new Set(["error", "aborted"]);

export function registerIntake(pi: ExtensionAPI, link: Link): void {
  const acknowledged = new Set<number>();
  const heldInRun = new Set<number>();
  const unanswered = new Set<number>();
  let lastStop: unknown;
  pi.on("context_with_system", (event) => {
    for (const message of event.messages) {
      const id = fleetEntryId(message);
      if (id === undefined || acknowledged.has(id)) continue;
      heldInRun.add(id);
      unanswered.add(id);
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    lastStop = event.message.stopReason;
    if (UNFINISHED.has(lastStop)) return;
    for (const entry of unanswered) link.read(entry);
    unanswered.clear();
  });
  pi.on("agent_settled", (event) => {
    if (!event.aborted && !UNFINISHED.has(lastStop)) {
      for (const id of heldInRun) {
        link.ack(id);
        acknowledged.add(id);
      }
    }
    heldInRun.clear();
    unanswered.clear();
    lastStop = undefined;
  });
}

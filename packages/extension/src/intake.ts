import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleetEntryId } from "./inbox.ts";
import type { Link } from "./link.ts";

const UNFINISHED: ReadonlySet<unknown> = new Set(["error", "aborted"]);

export function registerIntake(pi: ExtensionAPI, link: Link): void {
  const heldBySettledRun = new Set<number>();
  const heldInRun = new Set<number>();
  const unanswered = new Set<number>();
  let lastStop: unknown;
  pi.on("context_with_system", (event) => {
    for (const message of event.messages) {
      const id = fleetEntryId(message);
      if (id === undefined || heldBySettledRun.has(id)) continue;
      heldInRun.add(id);
      unanswered.add(id);
    }
  });
  pi.on("message_end", (event) => {
    const id = fleetEntryId(event.message);
    if (id !== undefined) heldBySettledRun.delete(id);
    if (event.message.role !== "assistant") return;
    lastStop = event.message.stopReason;
    if (UNFINISHED.has(lastStop)) return;
    for (const entry of unanswered) link.read(entry);
    unanswered.clear();
  });
  pi.on("agent_settled", (event) => {
    const taken = !event.aborted && !UNFINISHED.has(lastStop);
    for (const id of heldInRun) {
      if (taken) link.ack(id);
      heldBySettledRun.add(id);
    }
    heldInRun.clear();
    unanswered.clear();
    lastStop = undefined;
  });
}

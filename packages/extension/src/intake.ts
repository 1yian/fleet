import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleetEntryId } from "./inbox.ts";
import type { Link } from "./link.ts";

const UNFINISHED: ReadonlySet<unknown> = new Set(["error", "aborted"]);

export function registerIntake(pi: ExtensionAPI, link: Link): void {
  const inContext = new Set<number>();
  let lastStop: unknown;
  pi.on("message_end", (event) => {
    const id = fleetEntryId(event.message);
    if (id !== undefined) inContext.add(id);
    if (event.message.role === "assistant") lastStop = event.message.stopReason;
  });
  pi.on("agent_settled", (event) => {
    const taken = !event.aborted && !UNFINISHED.has(lastStop);
    if (taken) for (const id of inContext) link.ack(id);
    inContext.clear();
    lastStop = undefined;
  });
}

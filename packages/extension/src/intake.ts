import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleetEntryId, idsInModelContext } from "./inbox.ts";
import type { Link } from "./link.ts";

const UNFINISHED: ReadonlySet<unknown> = new Set(["error", "aborted"]);

export function registerIntake(pi: ExtensionAPI, link: Link, inFile: readonly number[]): void {
  const held = new Set<number>(inFile);
  const unread = new Set<number>();
  let lastStop: unknown;
  pi.on("message_end", (event, ctx) => {
    const delivered = fleetEntryId(event.message);
    if (delivered !== undefined) {
      held.add(delivered);
      unread.add(delivered);
    }
    if (event.message.role !== "assistant") return;
    lastStop = event.message.stopReason;
    if (UNFINISHED.has(lastStop) || unread.size === 0) return;
    const inContext = idsInModelContext(ctx.sessionManager);
    for (const id of unread) if (inContext.has(id)) link.read(id);
    unread.clear();
  });
  pi.on("agent_settled", (event, ctx) => {
    const finished = !event.aborted && !UNFINISHED.has(lastStop);
    lastStop = undefined;
    if (finished) {
      const inContext = idsInModelContext(ctx.sessionManager);
      for (const id of held) if (inContext.has(id)) link.ack(id);
    }
    held.clear();
    unread.clear();
  });
}

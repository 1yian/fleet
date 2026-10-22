import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleetEntryId } from "./inbox.ts";
import type { Link } from "./link.ts";

const UNFINISHED: ReadonlySet<unknown> = new Set(["error", "aborted"]);
const NO_MODEL =
  /no usable model|rate.?limit|usage.?limit|too many requests|\b429\b|overloaded|quota|exceed(?:ed)? your/i;

export function registerIntake(
  pi: ExtensionAPI,
  link: Link,
  forget: (entry: number) => void,
): void {
  const inContext = new Set<number>();
  let lastStop: unknown;
  let lastError = "";
  pi.on("message_end", (event) => {
    const id = fleetEntryId(event.message);
    if (id !== undefined) inContext.add(id);
    if (event.message.role !== "assistant") return;
    lastStop = event.message.stopReason;
    lastError = event.message.errorMessage ?? "";
  });
  pi.on("agent_settled", (event) => {
    const taken = !event.aborted && !UNFINISHED.has(lastStop);
    const noModel = !taken && !event.aborted && lastStop === "error" && NO_MODEL.test(lastError);
    for (const id of inContext) {
      if (taken) link.ack(id);
      else if (noModel) {
        forget(id);
        link.defer(id);
      }
    }
    inContext.clear();
    lastStop = undefined;
    lastError = "";
  });
}

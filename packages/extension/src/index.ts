// The fleet Pi extension. Dispatch starts each session with FLEET_URL,
// FLEET_TOKEN, and FLEET_ROLE (worker or mate). Without all three, or with any
// other role, the extension does nothing.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fleetEntryId, format, idsInSessionFile } from "./inbox.ts";
import { Link } from "./link.ts";
import { WorkerRun } from "./worker.ts";

export default function fleet(pi: ExtensionAPI): void {
  const url = process.env["FLEET_URL"];
  const token = process.env["FLEET_TOKEN"];
  const role = process.env["FLEET_ROLE"];
  if (url === undefined || token === undefined || (role !== "worker" && role !== "mate")) return;
  const injected = new Set<number>();
  let sessionFile: string | undefined;

  const link = new Link({
    url,
    token,
    inFile: () => idsInSessionFile(sessionFile),
    onConnect: () => {
      pi.events.emit("fleet:connected", {});
    },
    onPush: ({ entry, mode }) => {
      if (injected.has(entry.id)) return;
      injected.add(entry.id);
      pi.sendMessage(
        {
          customType: "fleet",
          content: format(entry),
          display: true,
          details: { entryId: entry.id },
        },
        { triggerTurn: true, deliverAs: mode },
      );
      // Other extensions, such as the calm UI, can follow what the fleet queued for this session.
      pi.events.emit("fleet:delivered", { entryId: entry.id, mode });
      worker?.reset();
    },
  });
  const worker = role === "worker" ? new WorkerRun(link) : undefined;
  worker?.register(pi);

  pi.on("session_start", (_event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile();
    for (const id of idsInSessionFile(sessionFile)) injected.add(id);
    link.start();
  });
  pi.on("session_shutdown", () => {
    link.stop();
  });
  pi.on("message_end", (event) => {
    const id = fleetEntryId(event.message);
    if (id !== undefined) link.ack(id);
  });
  pi.on("agent_start", () => {
    link.activity("running");
  });
  pi.on("agent_settled", () => {
    link.activity("idle");
  });
}

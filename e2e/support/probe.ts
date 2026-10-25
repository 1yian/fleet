import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { probeEdits } from "./probe-edits.ts";
import { isRecord, optionalNumber, optionalString, parseRecord } from "./json.ts";

function entryIdOf(message: unknown): number | undefined {
  if (!isRecord(message) || message["customType"] !== "fleet") return undefined;
  const details = message["details"];
  return isRecord(details) ? optionalNumber(details, "entryId") : undefined;
}

export default function probe(pi: ExtensionAPI): void {
  const url = (process.env["FLEET_CONTROL_URL"] ?? "").replace(/^http/, "ws");
  const socket = new WebSocket(`${url}/probe`);
  const outbox: string[] = [];
  const report = (event: Record<string, unknown>): void => {
    const line = JSON.stringify(event);
    if (socket.readyState === WebSocket.OPEN) socket.send(line);
    else outbox.push(line);
  };
  socket.addEventListener("open", () => {
    for (const line of outbox.splice(0)) socket.send(line);
  });

  const edit = probeEdits(pi, report);

  let release: (() => void) | undefined;
  socket.addEventListener("message", (event) => {
    const command = parseRecord(String(event.data));
    if (command["type"] === "release") release?.();
    edit(command);
    if (command["type"] !== "send") return;
    pi.sendMessage(
      {
        customType: "fleet",
        content: optionalString(command, "text") ?? "",
        display: true,
        details: { entryId: optionalNumber(command, "id") },
      },
      { triggerTurn: true, deliverAs: command["mode"] === "steer" ? "steer" : "followUp" },
    );
    report({ type: "sent", entryId: optionalNumber(command, "id") });
  });

  pi.registerTool({
    name: "slow_tool",
    label: "Slow tool",
    description: "Waits until the test releases it.",
    parameters: Type.Object({}),
    execute: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
        report({ type: "tool_waiting" });
      });
      return { content: [{ type: "text", text: "slow tool done" }], details: {} };
    },
  });

  pi.events.on("fleet:delivered", (data) => {
    if (isRecord(data))
      report({ type: "fleet_delivered", entryId: optionalNumber(data, "entryId") });
  });
  pi.events.on("fleet:connected", () => {
    report({ type: "fleet_connected" });
  });
  pi.on("session_start", (event, ctx) => {
    edit.started(ctx);
    report({
      type: "session",
      file: ctx.sessionManager.getSessionFile(),
      reason: event.reason,
      cwd: ctx.cwd,
    });
  });
  pi.on("message_start", (event) => {
    const entryId = entryIdOf(event.message);
    if (entryId !== undefined) report({ type: "message_start", entryId });
  });
  pi.on("message_end", (event) => {
    const entryId = entryIdOf(event.message);
    if (entryId !== undefined) report({ type: "message_end", entryId });
  });

  let nudged = process.env["PROBE_NUDGE"] !== "1";
  pi.on("agent_before_settle", (event) => {
    report({ type: "before_settle", pending: event.context.pendingMessages.length });
    if (nudged) return undefined;
    nudged = true;
    const nudge = { entryId: -1 };
    return {
      continue: true,
      entries: [
        {
          type: "custom_message",
          customType: "fleet",
          content: "nudge",
          display: true,
          details: nudge,
        },
      ],
    };
  });
  pi.on("agent_settled", (event) => {
    report({ type: "settled", aborted: event.aborted });
  });
}

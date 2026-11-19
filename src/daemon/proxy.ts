import WebSocket from "ws";
import type { Lane } from "./lane.js";
import { agentCommandError } from "./policy.js";
import { scrubNetworkEvent } from "./scrub.js";

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

const ACTIVITY =
  /^(Page\.(navigate|reload|bringToFront|navigateToHistoryEntry)|Input\.|Runtime\.(evaluate|callFunctionOn)|Target\.activateTarget)/;

export function proxyAgentConnection(client: WebSocket, lane: Lane, upstreamUrl: string): void {
  const upstream = new WebSocket(upstreamUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  const queued: string[] = [];
  const attachRequests = new Map<number, string>();
  const sessionTargets = new Map<string, string>();
  let upstreamOpen = false;

  const forward = (text: string): void => {
    let command: CdpMessage;
    try {
      command = JSON.parse(text) as CdpMessage;
    } catch {
      client.close(1003, "invalid json");
      return;
    }
    const method = command.method;
    const error = method ? agentCommandError(lane, method) : null;
    if (error && command.id !== undefined) {
      const reply: Record<string, unknown> = { id: command.id, error: { code: -32000, message: error } };
      if (command.sessionId) reply.sessionId = command.sessionId;
      client.send(JSON.stringify(reply));
      return;
    }
    if (
      method === "Target.attachToTarget" &&
      command.id !== undefined &&
      typeof command.params?.targetId === "string"
    ) {
      attachRequests.set(command.id, command.params.targetId);
    }
    if (method && ACTIVITY.test(method)) {
      const target =
        method === "Target.activateTarget"
          ? command.params?.targetId
          : sessionTargets.get(command.sessionId ?? "");
      if (typeof target === "string") lane.emit("activate", target);
    }
    upstream.send(text);
  };

  const observe = (text: string): void => {
    if (attachRequests.size === 0 && !text.includes('"Target.attachedToTarget"')) return;
    const message = JSON.parse(text) as CdpMessage & {
      params?: { sessionId?: string; targetInfo?: { targetId?: string } };
    };
    if (message.id !== undefined) {
      const target = attachRequests.get(message.id);
      if (target && typeof message.result?.sessionId === "string")
        sessionTargets.set(message.result.sessionId, target);
      attachRequests.delete(message.id);
    } else if (
      message.method === "Target.attachedToTarget" &&
      message.params?.sessionId &&
      message.params.targetInfo?.targetId
    ) {
      sessionTargets.set(message.params.sessionId, message.params.targetInfo.targetId);
    }
  };

  upstream.on("open", () => {
    upstreamOpen = true;
    for (const text of queued.splice(0)) forward(text);
  });
  client.on("message", (data) => {
    const text = data.toString();
    if (upstreamOpen) forward(text);
    else queued.push(text);
  });
  upstream.on("message", (data) => {
    const text = data.toString();
    observe(text);
    if (client.readyState === client.OPEN) client.send(scrubNetworkEvent(text));
  });
  const closeBoth = (): void => {
    if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) client.close();
    if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING)
      upstream.close();
  };
  client.on("close", closeBoth);
  client.on("error", closeBoth);
  upstream.on("close", closeBoth);
  upstream.on("error", closeBoth);
}

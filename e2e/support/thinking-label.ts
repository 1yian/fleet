import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function thinkingLabel(pi: ExtensionAPI): void {
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setHiddenThinkingLabel("Thinking...");
  });
}

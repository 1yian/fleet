import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function overlap(pi: ExtensionAPI): void {
  let stowing = false;
  pi.on("message_end", (event) => {
    if (event.message.role === "custom" && event.message.customType === "fleet-stow")
      stowing = true;
  });
  pi.on("agent_settled", () => {
    if (!stowing) return;
    stowing = false;
    pi.sendMessage(
      { customType: "stow-overlap", content: "An overlapping notification", display: true },
      { triggerTurn: true },
    );
  });
}

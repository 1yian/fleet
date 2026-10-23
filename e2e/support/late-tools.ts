import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SLOW_START_MS = 1500;

export default function lateTools(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, SLOW_START_MS));
    pi.registerTool({
      name: "late_search",
      label: "Late search",
      description: "Searches, once a slow extension has started.",
      promptSnippet: "Late search",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "found" }], details: {} }),
    });
    pi.setActiveTools([...pi.getActiveTools(), "late_search"]);
  });
}

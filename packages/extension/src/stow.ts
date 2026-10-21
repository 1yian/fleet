import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { publishShared } from "./lanes.ts";
import { STOW_PROMPT } from "./prompts.ts";
import { memoryReport } from "./standing.ts";

export function registerStow(pi: ExtensionAPI, home: string, lane: string | undefined): void {
  if (lane === undefined) return;
  let settled: (() => void) | undefined;
  pi.on("agent_settled", () => {
    const done = settled;
    settled = undefined;
    done?.();
  });
  pi.registerCommand("stow", {
    description:
      "Curate this mate's memory, route what only this conversation knows to its owner, file the open work it holds on the board, then reload AGENTS.md and the role contract in this same conversation.",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      if (ctx.hasUI) ctx.ui.notify("Stowing this conversation...", "info");
      const finished = new Promise<void>((resolve) => {
        settled = resolve;
      });
      pi.sendMessage(
        {
          customType: "fleet-stow",
          content: `${STOW_PROMPT}\n\n${memoryReport(home, lane, new Date())}`,
          display: false,
        },
        { triggerTurn: true },
      );
      await finished;
      const problem = lane === "main" ? await publishShared(home) : undefined;
      if (problem !== undefined && ctx.hasUI) ctx.ui.notify(problem, "warning");
      await ctx.reload();
    },
  });
}

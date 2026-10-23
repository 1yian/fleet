import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Link } from "./link.ts";
import { publishShared } from "./lanes.ts";
import { maintenanceReport } from "./maintenance.ts";
import { STOW_PROMPT } from "./prompts.ts";
import { memoryReport } from "./standing.ts";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function registerStow(
  pi: ExtensionAPI,
  home: string,
  lane: string | undefined,
  link: Link,
): (() => Promise<string | undefined>) | undefined {
  if (lane === undefined) return undefined;
  let settled: { resolve: () => void; reject: (error: Error) => void } | undefined;
  pi.on("agent_settled", (event) => {
    const done = settled;
    settled = undefined;
    if (event.aborted) done?.reject(new Error("stow was interrupted"));
    else done?.resolve();
  });
  const stow = async (): Promise<string | undefined> => {
    if (settled !== undefined) throw new Error("this conversation is already stowing");
    const finished = new Promise<void>((resolve, reject) => {
      settled = { resolve, reject };
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
    return lane === "main" ? publishShared(home) : undefined;
  };
  pi.registerCommand("stow", {
    description:
      "Curate this mate's memory, route what only this conversation knows to its owner, file the open work it holds on the board, then reload AGENTS.md and the role contract in this same conversation.",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      if (ctx.hasUI) ctx.ui.notify("Stowing this conversation...", "info");
      const asked =
        lane === "main"
          ? await link
              .call("maintenance.request", { batch: randomUUID(), kind: "stow" })
              .then(maintenanceReport, (error: unknown) => [
                `The second mates were not asked to stow: ${messageOf(error)}`,
              ])
          : [];
      if (asked.length > 0)
        pi.sendMessage(
          {
            customType: "fleet-stow-cascade",
            content: `[fleet] stow cascade:\n${asked.join("\n")}`,
            display: true,
          },
          { triggerTurn: false },
        );
      const problem = await stow();
      if (problem !== undefined && ctx.hasUI) ctx.ui.notify(problem, "warning");
      await ctx.reload();
    },
  });
  return stow;
}

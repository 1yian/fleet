import { hostname } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tierProblems, tierShortfall, tierStatusLine } from "./prerequisites.ts";

const TIERS_UI_KEY = "fleet-tiers";

export function refuseWithoutTiers(ctx: ExtensionContext, root: string): boolean {
  const shortfall = tierShortfall();
  if (shortfall === undefined) {
    if (ctx.hasUI) {
      ctx.ui.setStatus(TIERS_UI_KEY, undefined);
      ctx.ui.setWidget(TIERS_UI_KEY, undefined);
    }
    return false;
  }
  const lines = tierProblems(root, hostname(), shortfall).map((problem) => `fleet: ${problem}`);
  if (ctx.hasUI) {
    const status = tierStatusLine(shortfall);
    ctx.ui.notify(lines.join("\n"), "error");
    ctx.ui.setStatus(TIERS_UI_KEY, status);
    ctx.ui.setWidget(TIERS_UI_KEY, [
      status,
      `Missing tiers (${String(shortfall.missing.length)}): ${shortfall.missing.join(", ")}`,
    ]);
  } else for (const line of lines) console.error(line);
  return true;
}

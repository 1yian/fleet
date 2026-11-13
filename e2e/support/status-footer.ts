import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export default function statusFooter(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((_tui, theme, data) => ({
      invalidate: () => undefined,
      render(width: number): string[] {
        const location = "  ~/Projects/fleet   main  • 1stmate";
        const statuses = [...data.getExtensionStatuses()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => text)
          .join(theme.fg("dim", " · "));
        const space = width - visibleWidth(location) - visibleWidth(statuses) - 1;
        const rows =
          space >= 2
            ? [location + " ".repeat(space) + statuses]
            : [truncateToWidth(location, width), ` ${truncateToWidth(statuses, width - 1)}`];
        return [...rows, " orchestrator → scripted · fake"];
      },
    }));
  });
}

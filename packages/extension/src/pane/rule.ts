import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Slot } from "./deck.ts";

const MAX_DOTS = 10;
const RULE = "─";

function dots(theme: Theme, deck: readonly Slot[], at: number, clear: boolean): string {
  if (deck.length <= 1 || deck.length > MAX_DOTS) return "";
  const marks = deck.map((slot, place) => {
    if (place === at && !clear) return theme.fg("accent", "●");
    return slot.answered ? theme.fg("success", "✓") : theme.fg("muted", "○");
  });
  return ` ${marks.join("")}`;
}

export function topRule(
  theme: Theme,
  width: number,
  deck: readonly Slot[],
  at: number,
  clear: boolean,
): string {
  const name = clear ? "Decisions" : `Decision ${String(at + 1)} of ${String(deck.length)}`;
  const label = theme.style(name, { fg: theme.colors.accent, bold: true });
  const diamond = theme.style("◆", { fg: theme.colors.warning, bold: true });
  const title = ` ${diamond} ${label}${dots(theme, deck, at, clear)} `;
  const left = theme.fg("border", RULE.repeat(2));
  const room = Math.max(0, width - 2 - visibleWidth(title));
  return truncateToWidth(`${left}${title}${theme.fg("border", RULE.repeat(room))}`, width, "");
}

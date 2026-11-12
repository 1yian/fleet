import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

const NOTHING_WAITING = "Nothing is waiting for your decision.";
const NEXT_SHOWS_HERE = "The next one shows here by itself.";
const CLOSE_HINT = ["⏎ esc", " close"] as const;
const RULE = "─";
const PADDING = 1;

export function drawNothing(theme: Theme, top: string, width: number): string[] {
  const inner = Math.max(1, width - 2 * PADDING);
  const line = (text: string): string =>
    `${" ".repeat(PADDING)}${stripTerminalSequences(truncateToWidth(text, inner, "…"))}`;
  return [
    top,
    "",
    line(NOTHING_WAITING),
    theme.fg("muted", line(NEXT_SHOWS_HERE)),
    "",
    `${" ".repeat(PADDING)}${theme.fg("dim", CLOSE_HINT[0])}${theme.fg("muted", CLOSE_HINT[1])}`,
    theme.fg("border", RULE.repeat(width)),
  ];
}

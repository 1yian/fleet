import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  mixColors,
  replaceControlCharacters,
  stripTerminalSequences,
  type Color,
} from "@earendil-works/pi-tui";
import { KINDS, type Glance, type Kind } from "./glance.ts";

export const GLYPHS: Readonly<Record<Kind, string>> = {
  broken: "●",
  "needs-you": "◆",
  stalled: "◇",
};
const LANDED_GLYPH = "▲";
const CLEAR_TEXT = "✓ clear";
const DOWN_TEXT = "cardd: not answering";

type Colors = Theme["colors"];

export const TONES: Readonly<Record<Kind, (colors: Colors) => Color>> = {
  broken: (colors) => colors.error,
  "needs-you": (colors) => colors.warning,
  stalled: (colors) => mixColors(colors.warning, colors.error, 0.5),
};

export const plain = (text: string): string =>
  replaceControlCharacters(stripTerminalSequences(text));

export const decisionsText = (count: number): string | undefined => {
  if (count === 0) return undefined;
  return count === 1 ? "1 decision awaits you" : `${String(count)} decisions await you`;
};

function chip(theme: Theme, kind: Kind, count: number): string {
  return theme.style(`${GLYPHS[kind]} ${String(count)}`, { fg: TONES[kind](theme.colors) });
}

export function statusOf(theme: Theme, glance: Glance, decisions: number): string {
  const waiting = decisionsText(decisions);
  const raised = KINDS.flatMap((kind) =>
    glance.counts[kind] === 0 ? [] : [chip(theme, kind, glance.counts[kind])],
  );
  const calling = waiting === undefined ? [] : [theme.fg("warning", waiting)];
  const clear = waiting === undefined && raised.length === 0 ? [theme.fg("muted", CLEAR_TEXT)] : [];
  const landed =
    glance.landed === 0 ? [] : [theme.fg("success", `${LANDED_GLYPH} ${String(glance.landed)}`)];
  return [...calling, ...raised, ...clear, ...landed].join(" ");
}

export const downStatus = (theme: Theme): string =>
  theme.style(`${GLYPHS.broken} ${DOWN_TEXT}`, { fg: TONES.broken(theme.colors) });

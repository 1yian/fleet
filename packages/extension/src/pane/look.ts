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
const LABELS: Readonly<Record<Kind, string>> = {
  broken: "broken",
  "needs-you": "for you",
  stalled: "stalled",
};
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
  return `${String(count)} ${theme.style(LABELS[kind], { fg: TONES[kind](theme.colors) })}`;
}

export function statusOf(theme: Theme, glance: Glance, decisions: number): string {
  const waiting = decisionsText(decisions);
  const raised = KINDS.flatMap((kind) =>
    glance.counts[kind] === 0 ? [] : [chip(theme, kind, glance.counts[kind])],
  );
  const calling = waiting === undefined ? [] : [theme.fg("warning", waiting)];
  const landed =
    glance.landed === 0 ? [] : [`${String(glance.landed)} ${theme.fg("success", "landed")}`];
  return [...calling, ...raised, ...landed].join(" · ");
}

export const downStatus = (theme: Theme): string =>
  theme.style(`${GLYPHS.broken} ${DOWN_TEXT}`, { fg: TONES.broken(theme.colors) });

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
  own: "◆",
  stalled: "◇",
};
const DOWN_TEXT = "cardd: not answering";

type Colors = Theme["colors"];

export const TONES: Readonly<Record<Kind, (colors: Colors) => Color>> = {
  broken: (colors) => colors.error,
  own: (colors) => colors.warning,
  stalled: (colors) => mixColors(colors.warning, colors.error, 0.5),
};

export const COUNTED = ["decisions", ...KINDS, "landed"] as const;
export type Counted = (typeof COUNTED)[number];

interface Item {
  readonly key: Counted;
  readonly text: string;
  readonly styled: string;
}

const NOUNS: Readonly<Record<Exclude<Counted, "decisions">, readonly [string, string]>> = {
  broken: ["broken card", "broken cards"],
  own: ["task of yours", "tasks of yours"],
  stalled: ["stalled card", "stalled cards"],
  landed: ["landed card", "landed cards"],
};

export const plain = (text: string): string =>
  replaceControlCharacters(stripTerminalSequences(text));

const decisionsText = (count: number): string | undefined => {
  if (count === 0) return undefined;
  return count === 1 ? "1 decision awaits you" : `${String(count)} decisions await you`;
};

function counted(
  key: Exclude<Counted, "decisions">,
  count: number,
  tone: (words: string) => string,
): Item[] {
  if (count === 0) return [];
  const [one, many] = NOUNS[key];
  const words = count === 1 ? one : many;
  return [{ key, text: `${String(count)} ${words}`, styled: `${String(count)} ${tone(words)}` }];
}

export function itemsOf(theme: Theme, glance: Glance, decisions: number): Item[] {
  const waiting = decisionsText(decisions);
  const calling: Item[] =
    waiting === undefined
      ? []
      : [{ key: "decisions", text: waiting, styled: theme.fg("warning", waiting) }];
  const raised = KINDS.flatMap((kind) =>
    counted(kind, glance.cards[kind].length, (words) =>
      theme.style(words, { fg: TONES[kind](theme.colors) }),
    ),
  );
  const landed = counted("landed", glance.landed.length, (words) => theme.fg("success", words));
  return [...calling, ...raised, ...landed];
}

export const statusOf = (items: readonly Item[]): string =>
  items.map(({ styled }) => styled).join(" · ");

export const downStatus = (theme: Theme): string =>
  theme.style(`${GLYPHS.broken} ${DOWN_TEXT}`, { fg: TONES.broken(theme.colors) });

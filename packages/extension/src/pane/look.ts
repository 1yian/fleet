import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  mixColors,
  replaceControlCharacters,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Color,
  type Component,
} from "@earendil-works/pi-tui";
import { KINDS, type Glance, type Kind, type Need } from "./glance.ts";

const GLYPHS: Readonly<Record<Kind, string>> = { broken: "●", "needs-you": "◆", stalled: "◇" };
const LANDED_GLYPH = "▲";
const CLEAR_TEXT = "✓ clear";
const TINT = 0.13;
const MINUTE_MS = 60_000;

type Colors = Theme["colors"];

const TONES: Readonly<Record<Kind, (colors: Colors) => Color>> = {
  broken: (colors) => colors.error,
  "needs-you": (colors) => colors.warning,
  stalled: (colors) => mixColors(colors.warning, colors.error, 0.5),
};

function span(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 1) return "";
  if (minutes < 60) return ` (${String(minutes)}m)`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? ` (${String(hours)}h)` : ` (${String(Math.floor(hours / 24))}d)`;
}

const plain = (text: string): string => replaceControlCharacters(stripTerminalSequences(text));

const subject = (need: Need): string =>
  need.card === undefined ? need.title : `c-${String(need.card)} ${plain(need.title)}`;

const describe = (need: Need, now: number): string =>
  `${subject(need)}: ${need.why}${span(now - need.since)}`;

function chip(theme: Theme, kind: Kind, count: number): string {
  return theme.style(`${GLYPHS[kind]} ${String(count)}`, { fg: TONES[kind](theme.colors) });
}

export function chips(theme: Theme, glance: Glance): string {
  const counts = KINDS.map((kind) => glance.needs.filter((need) => need.kind === kind).length);
  const raised = KINDS.flatMap((kind, at) => {
    const count = counts[at] ?? 0;
    return count === 0 ? [] : [chip(theme, kind, count)];
  });
  const clear = glance.needs.length === 0 ? [theme.fg("muted", CLEAR_TEXT)] : [];
  const landed =
    glance.landed === 0 ? [] : [theme.fg("success", `${LANDED_GLYPH} ${String(glance.landed)}`)];
  return [...raised, ...clear, ...landed].join("  ");
}

export interface Row {
  readonly kind: Kind;
  readonly text: string;
  readonly more: number;
}

export const rowOf = (needs: readonly Need[], now: number): Row | undefined => {
  const [first] = needs;
  return first === undefined
    ? undefined
    : { kind: first.kind, text: describe(first, now), more: needs.length - 1 };
};

function paint(theme: Theme, row: Row, width: number): string {
  const { colors } = theme;
  const tone = TONES[row.kind](colors);
  const right = row.more === 0 ? "" : `+${String(row.more)} more `;
  const room = Math.max(0, width - 3 - visibleWidth(right));
  const text = truncateToWidth(row.text, room);
  const pad = " ".repeat(Math.max(0, width - 3 - visibleWidth(text) - visibleWidth(right)));
  const glyph = theme.style(GLYPHS[row.kind], { fg: tone, bold: true });
  const tint = mixColors(colors.userMessageBg, tone, TINT);
  return theme.style(` ${glyph} ${text}${pad}${right}`, { bg: tint });
}

export function strip(theme: Theme, row: Row): Component {
  return {
    render: (width) => [paint(theme, row, width)],
    invalidate: () => undefined,
  };
}

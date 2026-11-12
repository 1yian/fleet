import type { Theme } from "@earendil-works/pi-coding-agent";
import { packed } from "./wrap.ts";

export interface HintState {
  readonly sending: boolean;
  readonly kind: "option" | "words" | "later";
  readonly drafting: boolean;
  readonly open: number;
  readonly overflow: boolean;
  readonly choices: number;
  readonly row: number;
  readonly shown: number;
  readonly inner: number;
}

type Hint = readonly [string, string];

function enter(state: HintState): Hint[] {
  if (state.drafting) return [["⏎", state.kind === "later" ? "hold" : "send"]];
  return state.kind === "option" ? [["⏎", "select"]] : [];
}

function place(state: HintState, widest: boolean): string {
  if (!widest && state.shown >= state.choices) return "";
  return ` ${String(widest ? state.choices : state.row + 1)}/${String(state.choices)}`;
}

function hints(state: HintState, widest: boolean, reading: string): Hint[] {
  const { drafting, kind } = state;
  const inside = reading === "" ? "" : ` rows ${reading}`;
  return [
    ["↑↓", `choose${place(state, widest)}${inside}`],
    ...(state.open > 1 && !drafting ? [["←→", "decision"] as const] : []),
    ...enter(state),
    ...(drafting ? [] : [["type", kind === "later" ? "until when" : "your own words"] as const]),
    ...(state.overflow ? [["PgUp/PgDn", "read"] as const] : []),
    ["esc", drafting ? "clear" : "close"],
  ];
}

export function hintLines(theme: Theme, state: HintState, widest: boolean, reading = ""): string[] {
  if (state.sending) return [theme.fg("muted", "sending…")];
  const pieces = hints(state, widest, reading).map(
    ([key, what]) => `${theme.fg("dim", key)}${theme.fg("muted", ` ${what}`)}`,
  );
  return packed(pieces, state.inner, "   ");
}

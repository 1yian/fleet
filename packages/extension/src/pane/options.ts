import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, type Input } from "@earendil-works/pi-tui";
import { plain } from "./look.ts";
import { optionLines } from "./wrap.ts";

const RECOMMENDED = "(recommended)";
const POINTER = "→ ";

interface Typed {
  readonly line: Input;
  readonly label: string;
}

export interface Choices {
  readonly theme: Theme;
  readonly choices: readonly string[];
  readonly row: number;
  readonly write: Typed;
  readonly later: Typed;
}

const fitted = (text: string, width: number): string =>
  stripTerminalSequences(truncateToWidth(text, width, "…"));

function writeIn(theme: Theme, chosen: boolean, room: number, typed: Typed): string {
  const value = typed.line.getValue();
  if (chosen) return typed.line.render(room)[0] ?? "";
  if (value === "") return fitted(typed.label, room);
  return theme.fg("muted", fitted(`${typed.label} ${plain(value)}`, room));
}

export function choiceLines(env: Choices, at: number, inner: number, pointed: number): string[] {
  const { theme, choices } = env;
  const chosen = at === env.row;
  const pointer = chosen ? theme.fg("accent", POINTER) : " ".repeat(POINTER.length);
  const gutter = " ".repeat(POINTER.length);
  const room = Math.max(1, inner - POINTER.length);
  if (at === choices.length - 2) return [`${pointer}${writeIn(theme, chosen, room, env.write)}`];
  if (at === choices.length - 1) return [`${pointer}${writeIn(theme, chosen, room, env.later)}`];
  const tag = at === 0 && choices.length > 1 ? ` ${RECOMMENDED}` : "";
  const style = {
    word: (text: string) => (chosen ? theme.fg("accent", text) : text),
    quiet: (text: string) => theme.fg("muted", text),
  };
  return optionLines(plain(choices[at] ?? ""), room, tag, style).map(
    (text, index) => `${index === pointed ? pointer : gutter}${text}`,
  );
}

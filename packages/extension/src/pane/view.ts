import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Color,
  type Component,
} from "@earendil-works/pi-tui";
import { ownerText, runningText, waitsText, type Pulse } from "@fleet/protocol";
import { kindOf } from "./glance.ts";
import type { List, Listed } from "./list.ts";
import { GLYPHS, plain, TONES } from "./look.ts";

const MINUTE_MS = 60_000;
const SELECTED = "▌";
const RUNNING_GLYPH = "▶";
const QUIET_GLYPH = "◇";
const CHROME_ROWS = 5;
const RESET = "\u001b[0m";
const BACKGROUND_OFF = "\u001b[49m";

function ago(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)}h` : `${String(Math.round((hours / 24) * 10) / 10)}d`;
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

interface Look {
  readonly glyph: string;
  readonly tone: Color;
}

function lookOf(theme: Theme, pulse: Pulse): Look {
  const { colors } = theme;
  const kind = kindOf(pulse);
  if (kind !== undefined) return { glyph: GLYPHS[kind], tone: TONES[kind](colors) };
  if (pulse.state === "running") return { glyph: RUNNING_GLYPH, tone: colors.success };
  return { glyph: QUIET_GLYPH, tone: colors.muted };
}

const wordOf = (pulse: Pulse): string =>
  pulse.state === "you" ? "YOU" : pulse.state.toUpperCase();

export interface Links {
  readonly urlOf: (card: number) => string;
}

function block(theme: Theme, listed: Listed, now: number, links: Links): string[] {
  const { card, pulse } = listed;
  const { glyph, tone } = lookOf(theme, pulse);
  const id = `c-${String(card.id)}`;
  const linked = getCapabilities().hyperlinks ? hyperlink(id, links.urlOf(card.id)) : id;
  const word = `${glyph} ${wordOf(pulse)} ${ago(now - pulse.since)}`;
  const head = `${theme.style(word, { fg: tone, bold: true })}  ${linked} ${plain(card.lane)}`;
  const lines = [head, `  ${plain(card.title)}`];
  if (pulse.state === "you") return [...lines, ""];
  const moved = ago(now - pulse.movedAt);
  const who = `${ownerText(pulse.owner)} · running ${runningText(card)} · moved ${moved === "now" ? "just now" : `${moved} ago`}`;
  lines.push(
    theme.fg("muted", `  ${plain(who)}`),
    theme.fg("muted", `  ${plain(waitsText(card))}`),
  );
  if (pulse.behind !== null) {
    const { steps, started } = pulse.behind;
    const state = started === 0 ? "none started" : `${String(started)} started`;
    lines.push(theme.fg("muted", `  ${plural(steps, "step", "steps")} behind it, ${state}`));
  }
  return [...lines, ""];
}

function runningLine(theme: Theme, listed: Listed): string {
  const { card, pulse } = listed;
  const { colors } = theme;
  const glyph = theme.style(RUNNING_GLYPH, { fg: colors.success });
  const what = pulse.running === null ? "" : ` · ${plain(pulse.running.what)}`;
  return `  ${glyph} c-${String(card.id)} ${plain(card.lane)}  ${plain(card.title)}${what}`;
}

export class PulseView implements Component {
  private selected = 0;
  private top = 0;
  private expanded = false;
  private readonly theme: Theme;
  private readonly list: List;
  private readonly links: Links;
  private readonly rowsOf: () => number;
  private readonly done: (card: number | undefined) => void;

  constructor(
    theme: Theme,
    list: List,
    links: Links,
    rowsOf: () => number,
    done: (card: number | undefined) => void,
  ) {
    this.theme = theme;
    this.list = list;
    this.links = links;
    this.rowsOf = rowsOf;
    this.done = done;
  }

  private get items(): number {
    const { rows, running } = this.list;
    if (running.length === 0) return rows.length;
    return rows.length + 1 + (this.expanded ? running.length : 0);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") this.done(undefined);
    else if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down")) this.selected = Math.min(this.items - 1, this.selected + 1);
    else if (matchesKey(data, "return")) this.choose();
  }

  private choose(): void {
    const { rows, running } = this.list;
    const picked = rows[this.selected] ?? running[this.selected - rows.length - 1];
    if (picked !== undefined) this.done(picked.card.id);
    else if (this.selected === rows.length && running.length > 0) this.expanded = !this.expanded;
  }

  invalidate(): void {
    return undefined;
  }

  render(width: number): string[] {
    const { theme } = this;
    const now = Date.now();
    const blocks = [
      ...this.list.rows.map((row) => block(theme, row, now, this.links)),
      ...this.runningBlock(width),
    ];
    const budget = Math.max(6, this.rowsOf() - CHROME_ROWS);
    const shown =
      blocks.length === 0
        ? [{ lines: [theme.fg("muted", "Nothing is open.")], selected: false }]
        : this.window(blocks, budget);
    const inner = Math.max(10, width - 2);
    const edge = (text: string): string => theme.fg("accent", text);
    const title = `Pulse · ${String(this.list.open)} open · quiet first`;
    const lead = `╭─ ${title} `;
    const body = shown.flatMap(({ lines, selected }) =>
      lines.map((line) => this.row(line, selected && line !== "", inner)),
    );
    const hint = theme.fg("dim", "↑↓ move   ⏎ board link   esc close");
    return [
      edge(`${lead}${"─".repeat(Math.max(0, inner - visibleWidth(lead) + 1))}╮`),
      this.row("", false, inner),
      ...body,
      this.row(hint, false, inner),
      edge(`╰${"─".repeat(inner)}╯`),
    ];
  }

  private runningBlock(width: number): string[][] {
    const { running } = this.list;
    if (running.length === 0) return [];
    const { theme } = this;
    const glyph = theme.style(RUNNING_GLYPH, { fg: theme.colors.success });
    const left = `${glyph} ${String(running.length)} running`;
    const action = theme.fg("dim", this.expanded ? "⏎ collapse" : "⏎ expand");
    const gap = Math.max(1, width - 5 - visibleWidth(left) - visibleWidth(action));
    const summary = `${left}${" ".repeat(gap)}${action}`;
    const rows = this.expanded ? running.map((each) => [runningLine(theme, each)]) : [];
    return [[summary], ...rows];
  }

  private window(
    blocks: readonly string[][],
    budget: number,
  ): { lines: string[]; selected: boolean }[] {
    this.selected = Math.min(this.selected, Math.max(0, blocks.length - 1));
    this.top = Math.min(this.top, this.selected);
    const size = (from: number, to: number): number =>
      blocks.slice(from, to + 1).reduce((sum, each) => sum + each.length, 0);
    while (this.top < this.selected && size(this.top, this.selected) > budget) this.top += 1;
    const shown: { lines: string[]; selected: boolean }[] = [];
    let used = 0;
    for (let at = this.top; at < blocks.length; at += 1) {
      const lines = blocks[at] ?? [];
      if (at > this.selected && used + lines.length > budget) break;
      shown.push({ lines, selected: at === this.selected });
      used += lines.length;
    }
    return shown;
  }

  private row(content: string, selected: boolean, inner: number): string {
    const { theme } = this;
    const edge = theme.fg("accent", "│");
    const marker = selected ? theme.fg("accent", SELECTED) : " ";
    const room = Math.max(1, inner - 3);
    const text = truncateToWidth(content, room, "…");
    const pad = " ".repeat(Math.max(0, room - visibleWidth(text)));
    const cell = `${marker} ${text}${pad} `;
    const painted = selected ? this.selectedCell(cell) : cell;
    return `${edge}${painted}${edge}`;
  }

  private selectedCell(cell: string): string {
    const open = this.theme.getBgAnsi("selectedBg");
    return `${open}${cell.replaceAll(RESET, `${RESET}${open}`)}${BACKGROUND_OFF}`;
  }
}

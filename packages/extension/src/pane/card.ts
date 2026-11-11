import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  replaceControlCharacters,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { Decision } from "./decisions.ts";

const WRITE_LABEL = "My words…";
const RECOMMENDED = "recommended";
const MAX_DOTS = 10;
const MAX_BODY_ROWS = 16;
const MIN_BODY_ROWS = 2;
const FRAME_ROWS = 8;
const WRITE_ROWS = 2;
const BORDER_COLUMNS = 1;
const PADDING = 2;
const margin = " ".repeat(PADDING);
const BORDER = { across: "─", down: "│", corners: ["╭", "╮", "╰", "╯"] } as const;

export interface CardDeps {
  readonly theme: Theme;
  readonly keys: KeybindingsManager;
  readonly decisions: readonly Decision[];
  readonly rows: () => number;
  readonly send: (decision: Decision, choice: string, written: boolean) => Promise<void>;
  readonly reload: () => Promise<readonly Decision[]>;
  readonly redraw: () => void;
  readonly close: () => void;
}

type Mode = "choose" | "write";

const plain = (text: string): string => replaceControlCharacters(stripTerminalSequences(text));

function paragraphs(text: string, width: number): string[] {
  return text.split("\n").flatMap((line) => {
    const clean = plain(line).trimEnd();
    return clean === "" ? [""] : wrapTextWithAnsi(clean, width);
  });
}

const dots = (index: number, total: number): string =>
  total > MAX_DOTS
    ? ""
    : ` ${Array.from({ length: total }, (_, at) => (at === index ? "●" : "○")).join("")}`;

export class DecisionCard implements Component, Focusable {
  private decisions: readonly Decision[];
  private answered = 0;
  private index = 0;
  private row = 0;
  private scroll = 0;
  private choiceTop = 0;
  private mode: Mode = "choose";
  private sending = false;
  private note: string | undefined;
  private readonly input = new Input({ prompt: "", placeholder: "type your answer" });
  private readonly deps: CardDeps;
  private shown = false;

  constructor(deps: CardDeps) {
    this.deps = deps;
    this.decisions = deps.decisions;
    this.input.onSubmit = (value) => {
      this.answer(value.trim(), true);
    };
    this.input.onEscape = () => {
      this.mode = "choose";
      this.deps.redraw();
    };
  }

  get focused(): boolean {
    return this.shown;
  }

  set focused(value: boolean) {
    this.shown = value;
    this.input.focused = value;
  }

  private get current(): Decision | undefined {
    return this.decisions[this.index];
  }

  private get choices(): readonly string[] {
    return [...(this.current?.options ?? []), WRITE_LABEL];
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (this.sending) return;
    if (this.mode === "write") {
      this.input.handleInput(data);
      this.deps.redraw();
      return;
    }
    const { keys } = this.deps;
    if (keys.matches(data, "tui.select.cancel")) this.deps.close();
    else if (keys.matches(data, "tui.select.up")) this.move(-1);
    else if (keys.matches(data, "tui.select.down")) this.move(1);
    else if (keys.matches(data, "tui.select.confirm")) this.confirm();
    else if (matchesKey(data, "pageUp")) this.page(-1);
    else if (matchesKey(data, "pageDown")) this.page(1);
    else return;
    this.deps.redraw();
  }

  private move(step: number): void {
    const count = this.choices.length;
    this.row = (this.row + step + count) % count;
  }

  private shownChoices(): readonly [number, number] {
    const rows = this.pickRows();
    const last = this.choices.length - rows;
    const top = Math.max(this.row - rows + 1, Math.min(this.choiceTop, this.row));
    this.choiceTop = Math.max(0, Math.min(last, top));
    return [this.choiceTop, rows];
  }

  private page(step: number): void {
    this.scroll = Math.max(0, this.scroll + step * this.bodyRows());
  }

  private confirm(): void {
    const choice = this.choices[this.row];
    if (choice === undefined) return;
    if (this.row === this.choices.length - 1) {
      this.mode = "write";
      this.input.setValue("");
      return;
    }
    this.answer(choice, false);
  }

  private answer(choice: string, written: boolean): void {
    const decision = this.current;
    if (decision === undefined || choice === "" || this.sending) return;
    this.sending = true;
    this.note = undefined;
    this.deps.redraw();
    this.deps.send(decision, choice, written).then(
      () => {
        this.sending = false;
        this.next();
      },
      (error: unknown) => {
        this.refused(decision, error);
      },
    );
  }

  private next(): void {
    this.answered += 1;
    this.decisions = this.decisions.filter((_, at) => at !== this.index);
    this.index = Math.min(this.index, Math.max(0, this.decisions.length - 1));
    this.settle();
    if (this.decisions.length === 0) this.deps.close();
    else this.deps.redraw();
  }

  private refused(decision: Decision, error: unknown): void {
    const why = error instanceof Error ? error.message : String(error);
    this.note = plain(why);
    this.deps.reload().then(
      (fresh) => {
        this.sending = false;
        this.decisions = fresh;
        const at = fresh.findIndex((each) => each.card === decision.card);
        this.index = at === -1 ? Math.min(this.index, Math.max(0, fresh.length - 1)) : at;
        this.settle();
        if (fresh.length === 0) this.deps.close();
        else this.deps.redraw();
      },
      () => {
        this.sending = false;
        this.deps.redraw();
      },
    );
  }

  private settle(): void {
    this.row = 0;
    this.scroll = 0;
    this.choiceTop = 0;
    this.mode = "choose";
  }

  private spare(): number {
    const fixed = FRAME_ROWS + (this.note === undefined ? 0 : 1);
    return Math.max(2, this.deps.rows() - fixed);
  }

  private pickRows(): number {
    if (this.mode === "write") return WRITE_ROWS;
    return Math.min(this.choices.length, Math.max(1, this.spare() - MIN_BODY_ROWS));
  }

  private bodyRows(): number {
    return Math.max(1, Math.min(MAX_BODY_ROWS, this.spare() - this.pickRows()));
  }

  render(width: number): string[] {
    const decision = this.current;
    if (decision === undefined) return [];
    const { theme } = this.deps;
    const inner = Math.max(1, width - 2 * (BORDER_COLUMNS + PADDING));
    const edge = (text: string): string => theme.fg("accent", text);
    const line = (text: string): string => {
      const pad = " ".repeat(Math.max(0, inner - visibleWidth(text)));
      return `${edge(BORDER.down)}${margin}${text}${pad}${margin}${edge(BORDER.down)}`;
    };
    const quiet = (text: string): string => line(theme.fg("muted", this.fit(text, inner)));
    const body = paragraphs(decision.question, inner);
    const rows = this.bodyRows();
    const top = Math.min(this.scroll, Math.max(0, body.length - rows));
    this.scroll = top;
    const shown = body.slice(top, top + rows).map(line);
    const lower = body.length - top - rows;
    const lines = [
      this.top(width),
      line(""),
      quiet(`c-${String(decision.card)} ${plain(decision.title)}`),
      line(""),
      ...shown,
      lower > 0 ? quiet(`▼ ${String(lower)} more lines, PgDn to read`) : line(""),
      ...this.choiceRows(decision, inner).map(line),
      line(""),
      ...(this.note === undefined ? [] : [line(theme.fg("warning", this.fit(this.note, inner)))]),
      quiet(this.hint(body.length > rows)),
      edge(`${BORDER.corners[2]}${BORDER.across.repeat(width - 2)}${BORDER.corners[3]}`),
    ];
    return lines;
  }

  private fit(text: string, width: number): string {
    return stripTerminalSequences(truncateToWidth(text, width, "…"));
  }

  private top(width: number): string {
    const { theme } = this.deps;
    const total = this.answered + this.decisions.length;
    const place = this.answered + this.index;
    const label = `Decision ${String(place + 1)} of ${String(total)}${dots(place, total)}`;
    const title = ` ${theme.style("◆", { fg: theme.colors.warning, bold: true })} ${label} `;
    const room = Math.max(0, width - 4 - visibleWidth(title));
    const [left, right] = BORDER.corners;
    const edge = (text: string): string => theme.fg("accent", text);
    return `${edge(`${left}${BORDER.across}`)}${title}${edge(`${BORDER.across.repeat(room)}${right}`)}`;
  }

  private choiceRows(decision: Decision, inner: number): string[] {
    if (this.mode === "write") {
      const { theme } = this.deps;
      const typed = this.input.render(inner)[0] ?? "";
      return [theme.fg("muted", `Your words for c-${String(decision.card)}:`), typed];
    }
    const [top, rows] = this.shownChoices();
    return this.choices
      .slice(top, top + rows)
      .map((label, at) => this.choice(label, top + at, inner));
  }

  private choice(label: string, at: number, inner: number): string {
    const { theme } = this.deps;
    const chosen = at === this.row;
    const tag = at === 0 && this.choices.length > 1 ? RECOMMENDED : "";
    const room = inner - 2 - (tag === "" ? 0 : visibleWidth(tag) + 1);
    const text = this.fit(plain(label), room);
    const gap = " ".repeat(Math.max(0, inner - 2 - visibleWidth(text) - visibleWidth(tag)));
    const mark = chosen ? theme.style("▌", { fg: theme.colors.accent }) : " ";
    const row = `${mark} ${text}${gap}${theme.fg("muted", tag)}`;
    return chosen ? theme.style(row, { bg: theme.colors.userMessageBg }) : row;
  }

  private hint(overflow: boolean): string {
    if (this.sending) return "sending…";
    if (this.mode === "write") return "⏎ send   esc back";
    const read = overflow ? "   PgUp/PgDn read" : "";
    const count = this.choices.length;
    const place = this.pickRows() < count ? ` ${String(this.row + 1)}/${String(count)}` : "";
    return `↑↓ choose${place}   ⏎ confirm${read}   esc later`;
  }
}

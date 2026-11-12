import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { LATER_EXAMPLES } from "@fleet/protocol";
import { merged, type Slot } from "./deck.ts";
import type { Decision } from "./decisions.ts";
import { plain } from "./look.ts";
import { drawNothing } from "./rest.ts";
import { oneLine, paragraphs } from "./text.ts";

const WRITE_LABEL = "My words…";
const LATER_LABEL = "Later…";
const RECOMMENDED = "(recommended)";
const MAX_DOTS = 10;
const MAX_BODY_ROWS = 16;
const MIN_BODY_ROWS = 2;
const FRAME_ROWS = 5;
const SPACER_ROWS = 3;
const PADDING = 1;
const RULE = "─";
const POINTER = "→ ";
const margin = " ".repeat(PADDING);

export interface CardDeps {
  readonly theme: Theme;
  readonly keys: KeybindingsManager;
  readonly decisions: readonly Decision[];
  readonly rows: () => number;
  readonly send: (decision: Decision, choice: string, written: boolean) => Promise<void>;
  readonly later: (decision: Decision, said: string) => Promise<void>;
  readonly reload: () => Promise<readonly Decision[]>;
  readonly refresh: () => void;
  readonly redraw: () => void;
  readonly close: () => void;
}

type Row = "option" | "words" | "later";

interface Layout {
  readonly spacers: number;
  readonly body: number;
  readonly picks: number;
}

export class DecisionCard implements Component, Focusable {
  readonly capturesViewportInput = true;
  private deck: readonly Slot[];
  private at = 0;
  private row = 0;
  private scroll = 0;
  private choiceTop = 0;
  private firstPick = 0;
  private shownPicks = 0;
  private overflow = false;
  private sending = false;
  private note: string | undefined;
  private arrival: string | undefined;
  private focus = false;
  private readonly input: Input;
  private readonly when: Input;
  private readonly deps: CardDeps;

  constructor(deps: CardDeps) {
    this.deps = deps;
    this.deck = deps.decisions.map((decision) => ({ decision, answered: false }));
    this.input = this.typedLine(WRITE_LABEL);
    this.when = this.typedLine(`${LATER_LABEL} ${LATER_EXAMPLES}`);
  }

  private typedLine(placeholder: string): Input {
    return new Input({
      prompt: "",
      placeholder,
      placeholderStyle: (text) => this.deps.theme.fg("accent", text),
    });
  }

  get focused(): boolean {
    return this.focus;
  }

  set focused(value: boolean) {
    this.focus = value;
    this.input.focused = value;
    this.when.focused = value;
  }

  private get current(): Decision | undefined {
    return this.deck[this.at]?.decision;
  }

  private get choices(): readonly string[] {
    return [...(this.current?.options ?? []), WRITE_LABEL, LATER_LABEL];
  }

  private get writeRow(): number {
    return this.choices.length - 2;
  }

  private get laterRow(): number {
    return this.choices.length - 1;
  }

  private get kind(): Row {
    if (this.row === this.writeRow) return "words";
    return this.row === this.laterRow ? "later" : "option";
  }

  private get typed(): Input {
    return this.kind === "later" ? this.when : this.input;
  }

  private get words(): string {
    return this.input.getValue().trim();
  }

  private get drafting(): boolean {
    return this.kind !== "option" && this.typed.getValue().trim() !== "";
  }

  private get open(): number {
    return this.deck.filter((slot) => !slot.answered).length;
  }

  private get clear(): boolean {
    return this.open === 0;
  }

  invalidate(): void {
    this.input.invalidate();
    this.when.invalidate();
  }

  handleInput(data: string): void {
    if (this.sending) return;
    if (this.clear) {
      if (this.confirms(data) || this.deps.keys.matches(data, "tui.select.cancel"))
        this.deps.close();
      return;
    }
    if (!this.confirms(data)) this.arrival = undefined;
    if (!this.choose(data) && !this.read(data) && !this.across(data)) this.type(data);
    this.deps.redraw();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.sending) return { handled: true };
    return this.clear ? undefined : this.press(event);
  }

  private confirms(data: string): boolean {
    return this.deps.keys.matches(data, "tui.select.confirm") || data === "\n";
  }

  private choose(data: string): boolean {
    const { keys } = this.deps;
    if (keys.matches(data, "tui.select.cancel")) this.cancel();
    else if (keys.matches(data, "tui.select.up")) this.move(-1);
    else if (keys.matches(data, "tui.select.down")) this.move(1);
    else if (this.confirms(data)) this.confirm();
    else return false;
    return true;
  }

  private read(data: string): boolean {
    if (matchesKey(data, "pageUp")) this.page(-1);
    else if (matchesKey(data, "pageDown")) this.page(1);
    else return false;
    return true;
  }

  private across(data: string): boolean {
    if (matchesKey(data, "left")) this.sideways(-1, data);
    else if (matchesKey(data, "right")) this.sideways(1, data);
    else return false;
    return true;
  }

  private press(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click"))
      return undefined;
    if (event.type === "press") this.arrival = undefined;
    const at = event.y - this.firstPick;
    if (at < 0 || at >= this.shownPicks) return undefined;
    this.row = this.choiceTop + at;
    if (event.type === "click" && this.kind === "option") this.confirm();
    return { handled: true };
  }

  private cancel(): void {
    if (this.drafting) this.typed.setValue("");
    else this.deps.close();
  }

  private move(step: number): void {
    const count = this.choices.length;
    this.row = (this.row + step + count) % count;
  }

  private sideways(step: number, data: string): void {
    if (this.kind !== "option" && this.typed.getValue() !== "") this.typed.handleInput(data);
    else this.turn(step);
  }

  private type(data: string): void {
    const line = this.typed;
    const before = line.getValue();
    line.handleInput(oneLine(data));
    if (line.getValue() !== before && this.kind === "option") this.row = this.writeRow;
  }

  private turn(step: number): void {
    const count = this.deck.length;
    for (let away = 1; away < count; away += 1) {
      const to = (((this.at + step * away) % count) + count) % count;
      if (this.deck[to]?.answered !== false) continue;
      this.at = to;
      this.settle();
      return;
    }
  }

  private shownChoices(picks: number): number {
    const last = this.choices.length - picks;
    const top = Math.max(this.row - picks + 1, Math.min(this.choiceTop, this.row));
    this.choiceTop = Math.max(0, Math.min(last, top));
    return this.choiceTop;
  }

  private page(step: number): void {
    this.scroll = Math.max(0, this.scroll + step * this.layout().body);
  }

  private confirm(): void {
    if (this.arrival !== undefined) {
      this.arrival = undefined;
      return;
    }
    const { kind } = this;
    if (kind === "words") this.answer(this.words, true);
    else if (kind === "later") this.defer(this.when.getValue().trim());
    else {
      const choice = this.choices[this.row];
      if (choice !== undefined) this.answer(choice, false);
    }
  }

  private answer(choice: string, written: boolean): void {
    if (choice !== "") this.submit((decision) => this.deps.send(decision, choice, written));
  }

  private defer(said: string): void {
    if (said !== "") this.submit((decision) => this.deps.later(decision, said));
  }

  private submit(run: (decision: Decision) => Promise<void>): void {
    const decision = this.current;
    if (decision === undefined || this.sending) return;
    this.sending = true;
    this.note = undefined;
    this.deps.redraw();
    run(decision).then(
      () => {
        this.answered(decision);
      },
      (error: unknown) => {
        this.refused(error);
      },
    );
  }

  private answered(decision: Decision): void {
    this.deck = this.deck.map((slot) =>
      slot.decision.card === decision.card && !slot.answered ? { ...slot, answered: true } : slot,
    );
    this.input.setValue("");
    this.when.setValue("");
    if (this.open > 0) {
      this.sending = false;
      this.turn(1);
      this.deps.refresh();
      this.deps.redraw();
      return;
    }
    this.deps.reload().then(
      (fresh) => {
        this.sending = false;
        this.apply(fresh);
        this.leaveIfClear();
      },
      () => {
        this.sending = false;
        this.deps.close();
      },
    );
  }

  private refused(error: unknown): void {
    const why = error instanceof Error ? error.message : String(error);
    this.note = plain(why);
    this.deps.reload().then(
      (fresh) => {
        this.sending = false;
        this.apply(fresh);
        this.arrival = undefined;
        this.leaveIfClear();
      },
      () => {
        this.sending = false;
        this.deps.redraw();
      },
    );
  }

  private leaveIfClear(): void {
    if (this.clear) this.deps.close();
    else this.deps.redraw();
  }

  sync(fresh: readonly Decision[]): void {
    if (this.sending) return;
    this.apply(fresh);
    this.deps.redraw();
  }

  private apply(fresh: readonly Decision[]): void {
    const before = this.current;
    const { kind } = this;
    const picked = kind === "option" ? this.choices[this.row] : undefined;
    const next = merged(this.deck, this.at, fresh);
    this.deck = next.deck;
    this.at = next.at;
    if (!next.stayed) this.settle();
    else if (this.current?.hold !== before?.hold) this.row = this.follow(kind, picked);
    if (next.arrival !== undefined) this.arrival = next.arrival;
  }

  private follow(kind: Row, picked: string | undefined): number {
    if (kind === "words") return this.writeRow;
    if (kind === "later") return this.laterRow;
    return Math.max(0, (this.current?.options ?? []).indexOf(picked ?? ""));
  }

  private settle(): void {
    this.row = 0;
    this.scroll = 0;
    this.choiceTop = 0;
    this.input.setValue("");
    this.when.setValue("");
  }

  private layout(): Layout {
    const free = this.deps.rows() - FRAME_ROWS - (this.warning === undefined ? 0 : 1);
    const picks = Math.min(this.choices.length, Math.max(1, free - MIN_BODY_ROWS));
    const left = free - picks;
    const spacers = Math.max(0, Math.min(SPACER_ROWS, left - MIN_BODY_ROWS));
    const body = Math.max(1, Math.min(MAX_BODY_ROWS, left - spacers));
    return { spacers, body, picks };
  }

  private get warning(): string | undefined {
    return this.note ?? this.arrival;
  }

  render(width: number): string[] {
    const { theme } = this.deps;
    const inner = Math.max(1, width - 2 * PADDING);
    const line = (text: string): string => `${margin}${text}`;
    const quiet = (text: string): string => line(theme.fg("muted", this.fit(text, inner)));
    const decision = this.current;
    if (this.clear || decision === undefined) return drawNothing(theme, this.top(width), width);
    const body = paragraphs(decision.question, inner);
    const layout = this.layout();
    const rows = layout.body;
    const spacer = (rank: number): string[] => (layout.spacers >= rank ? [""] : []);
    const top = Math.min(this.scroll, Math.max(0, body.length - rows));
    this.scroll = top;
    this.overflow = body.length > rows;
    const lower = body.length - top - rows;
    const lines = [
      this.top(width),
      ...spacer(3),
      quiet(`c-${String(decision.card)} ${plain(decision.title)}`),
      ...spacer(1),
      ...body.slice(top, top + rows).map(line),
      lower > 0 ? quiet(`▼ ${String(lower)} more lines, PgDn to read`) : "",
    ];
    this.firstPick = lines.length;
    const picks = this.choiceRows(inner, layout.picks);
    this.shownPicks = picks.length;
    return [
      ...lines,
      ...picks.map(line),
      ...spacer(2),
      ...(this.warning === undefined
        ? []
        : [line(theme.fg("warning", this.fit(this.warning, inner)))]),
      line(this.hint(inner)),
      theme.fg("border", RULE.repeat(width)),
    ];
  }

  private fit(text: string, width: number): string {
    return stripTerminalSequences(truncateToWidth(text, width, "…"));
  }

  private top(width: number): string {
    const { theme } = this.deps;
    const place = this.at;
    const total = this.deck.length;
    const name = this.clear ? "Decisions" : `Decision ${String(place + 1)} of ${String(total)}`;
    const label = theme.style(name, { fg: theme.colors.accent, bold: true });
    const diamond = theme.style("◆", { fg: theme.colors.warning, bold: true });
    const title = ` ${diamond} ${label}${this.dots()} `;
    const left = theme.fg("border", RULE.repeat(2));
    const room = Math.max(0, width - 2 - visibleWidth(title));
    return `${left}${title}${theme.fg("border", RULE.repeat(room))}`;
  }

  private dots(): string {
    const { theme } = this.deps;
    if (this.deck.length <= 1 || this.deck.length > MAX_DOTS) return "";
    const marks = this.deck.map((slot, place) => {
      if (place === this.at && !this.clear) return theme.fg("accent", "●");
      return slot.answered ? theme.fg("success", "✓") : theme.fg("muted", "○");
    });
    return ` ${marks.join("")}`;
  }

  private choiceRows(inner: number, picks: number): string[] {
    const top = this.shownChoices(picks);
    return this.choices
      .slice(top, top + picks)
      .map((label, at) => this.choice(label, top + at, inner));
  }

  private choice(label: string, at: number, inner: number): string {
    const { theme } = this.deps;
    const chosen = at === this.row;
    const pointer = chosen ? theme.fg("accent", POINTER) : " ".repeat(POINTER.length);
    const room = inner - POINTER.length;
    if (at === this.writeRow)
      return `${pointer}${this.writeIn(chosen, room, this.input, WRITE_LABEL)}`;
    if (at === this.laterRow)
      return `${pointer}${this.writeIn(chosen, room, this.when, LATER_LABEL)}`;
    const tag = at === 0 && this.choices.length > 1 ? ` ${RECOMMENDED}` : "";
    const text = this.fit(plain(label), room - visibleWidth(tag));
    const word = chosen ? theme.fg("accent", text) : text;
    return `${pointer}${word}${theme.fg("muted", tag)}`;
  }

  private writeIn(chosen: boolean, room: number, line: Input, label: string): string {
    const { theme } = this.deps;
    const typed = line.getValue();
    if (chosen) return line.render(room)[0] ?? "";
    if (typed === "") return this.fit(label, room);
    return theme.fg("muted", this.fit(`${label} ${plain(typed)}`, room));
  }

  private hint(inner: number): string {
    const { theme } = this.deps;
    if (this.sending) return theme.fg("muted", "sending…");
    const text = this.hints()
      .map(([key, what]) => `${theme.fg("dim", key)}${theme.fg("muted", ` ${what}`)}`)
      .join("   ");
    return truncateToWidth(text, inner, "…");
  }

  private hints(): (readonly [string, string])[] {
    const { drafting, kind } = this;
    return [
      ["↑↓", `choose${this.place()}`],
      ...(this.open > 1 && !drafting ? [["←→", "decision"] as const] : []),
      ...this.enter(drafting),
      ...(drafting ? [] : [["type", kind === "later" ? "until when" : "your own words"] as const]),
      ...(this.overflow ? [["PgUp/PgDn", "read"] as const] : []),
      ["esc", drafting ? "clear" : "close"],
    ];
  }

  private enter(drafting: boolean): (readonly [string, string])[] {
    if (drafting) return [["⏎", this.kind === "later" ? "hold" : "send"]];
    return this.kind === "option" ? [["⏎", "select"]] : [];
  }

  private place(): string {
    const count = this.choices.length;
    return this.shownPicks < count ? ` ${String(this.row + 1)}/${String(count)}` : "";
  }
}

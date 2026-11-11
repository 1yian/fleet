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
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Decision } from "./decisions.ts";

const WRITE_LABEL = "My words…";
const RECOMMENDED = "(recommended)";
const MAX_DOTS = 10;
const MAX_BODY_ROWS = 16;
const MIN_BODY_ROWS = 2;
const FRAME_ROWS = 5;
const SPACER_ROWS = 3;
const PADDING = 1;
const RULE = "─";
const POINTER = "→ ";
const PASTE_START = "\u001b[200~";
const margin = " ".repeat(PADDING);

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

interface Slot {
  readonly decision: Decision;
  readonly answered: boolean;
}

interface Layout {
  readonly spacers: number;
  readonly body: number;
  readonly picks: number;
}

const oneLine = (data: string): string =>
  data.includes(PASTE_START) ? data.replace(/\s*[\r\n]+\s*/g, " ") : data;

const plain = (text: string): string => replaceControlCharacters(stripTerminalSequences(text));

function paragraphs(text: string, width: number): string[] {
  return text.split("\n").flatMap((line) => {
    const clean = plain(line).trimEnd();
    return clean === "" ? [""] : wrapTextWithAnsi(clean, width);
  });
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
  private focus = false;
  private readonly input: Input;
  private readonly deps: CardDeps;

  constructor(deps: CardDeps) {
    this.deps = deps;
    this.deck = deps.decisions.map((decision) => ({ decision, answered: false }));
    this.input = new Input({
      prompt: "",
      placeholder: WRITE_LABEL,
      placeholderStyle: (text) => deps.theme.fg("accent", text),
    });
  }

  get focused(): boolean {
    return this.focus;
  }

  set focused(value: boolean) {
    this.focus = value;
    this.input.focused = value;
  }

  private get current(): Decision | undefined {
    return this.deck[this.at]?.decision;
  }

  private get choices(): readonly string[] {
    return [...(this.current?.options ?? []), WRITE_LABEL];
  }

  private get writeRow(): number {
    return this.choices.length - 1;
  }

  private get writing(): boolean {
    return this.row === this.writeRow;
  }

  private get words(): string {
    return this.input.getValue().trim();
  }

  private get open(): number {
    return this.deck.filter((slot) => !slot.answered).length;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    if (this.sending) return;
    if (!this.choose(data) && !this.read(data) && !this.across(data)) this.type(data);
    this.deps.redraw();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.sending) return { handled: true };
    return this.press(event);
  }

  private choose(data: string): boolean {
    const { keys } = this.deps;
    if (keys.matches(data, "tui.select.cancel")) this.cancel();
    else if (keys.matches(data, "tui.select.up")) this.move(-1);
    else if (keys.matches(data, "tui.select.down")) this.move(1);
    else if (keys.matches(data, "tui.select.confirm") || data === "\n") this.confirm();
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
    const at = event.y - this.firstPick;
    if (at < 0 || at >= this.shownPicks) return undefined;
    this.row = this.choiceTop + at;
    if (event.type === "click" && !this.writing) this.confirm();
    return { handled: true };
  }

  private cancel(): void {
    if (this.writing && this.words !== "") this.input.setValue("");
    else this.deps.close();
  }

  private move(step: number): void {
    const count = this.choices.length;
    this.row = (this.row + step + count) % count;
  }

  private sideways(step: number, data: string): void {
    if (this.writing && this.input.getValue() !== "") this.input.handleInput(data);
    else this.turn(step);
  }

  private type(data: string): void {
    const before = this.input.getValue();
    this.input.handleInput(oneLine(data));
    if (this.input.getValue() !== before) this.row = this.writeRow;
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
    if (!this.writing) {
      const choice = this.choices[this.row];
      if (choice !== undefined) this.answer(choice, false);
      return;
    }
    this.answer(this.words, true);
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
    this.deck = this.deck.map((slot, place) =>
      place === this.at ? { ...slot, answered: true } : slot,
    );
    this.input.setValue("");
    if (this.open === 0) {
      this.deps.close();
      return;
    }
    this.turn(1);
    this.deps.redraw();
  }

  private refused(decision: Decision, error: unknown): void {
    const why = error instanceof Error ? error.message : String(error);
    this.note = plain(why);
    this.deps.reload().then(
      (fresh) => {
        this.sending = false;
        this.reconcile(fresh, decision);
        if (this.open === 0) this.deps.close();
        else this.deps.redraw();
      },
      () => {
        this.sending = false;
        this.deps.redraw();
      },
    );
  }

  private reconcile(fresh: readonly Decision[], refused: Decision): void {
    const waiting = new Map(fresh.map((each) => [each.card, each]));
    const kept = new Set<number>();
    const deck: Slot[] = [];
    let landing = -1;
    this.deck.forEach((slot, place) => {
      const decision = slot.answered ? slot.decision : waiting.get(slot.decision.card);
      if (decision === undefined) return;
      if (!slot.answered) kept.add(decision.card);
      if (landing === -1 && !slot.answered && place >= this.at) landing = deck.length;
      deck.push({ decision, answered: slot.answered });
    });
    for (const decision of fresh)
      if (!kept.has(decision.card)) deck.push({ decision, answered: false });
    const same = deck.findIndex((slot) => !slot.answered && slot.decision.card === refused.card);
    const first = deck.findIndex((slot) => !slot.answered);
    const picked = this.writing ? undefined : this.choices[this.row];
    this.deck = deck;
    this.at = Math.max(0, same !== -1 ? same : landing !== -1 ? landing : first);
    if (same === -1) this.settle();
    else this.row = this.follow(picked);
  }

  private follow(picked: string | undefined): number {
    if (picked === undefined) return this.writeRow;
    return Math.max(0, (this.current?.options ?? []).indexOf(picked));
  }

  private settle(): void {
    this.row = 0;
    this.scroll = 0;
    this.choiceTop = 0;
    this.input.setValue("");
  }

  private layout(): Layout {
    const free = this.deps.rows() - FRAME_ROWS - (this.note === undefined ? 0 : 1);
    const picks = Math.min(this.choices.length, Math.max(1, free - MIN_BODY_ROWS));
    const left = free - picks;
    const spacers = Math.max(0, Math.min(SPACER_ROWS, left - MIN_BODY_ROWS));
    const body = Math.max(1, Math.min(MAX_BODY_ROWS, left - spacers));
    return { spacers, body, picks };
  }

  render(width: number): string[] {
    const decision = this.current;
    if (decision === undefined) return [];
    const { theme } = this.deps;
    const inner = Math.max(1, width - 2 * PADDING);
    const line = (text: string): string => `${margin}${text}`;
    const quiet = (text: string): string => line(theme.fg("muted", this.fit(text, inner)));
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
      ...(this.note === undefined ? [] : [line(theme.fg("warning", this.fit(this.note, inner)))]),
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
    const name = `Decision ${String(place + 1)} of ${String(total)}`;
    const label = theme.style(name, { fg: theme.colors.accent, bold: true });
    const diamond = theme.style("◆", { fg: theme.colors.warning, bold: true });
    const title = ` ${diamond} ${label}${this.dots()} `;
    const left = theme.fg("border", RULE.repeat(2));
    const room = Math.max(0, width - 2 - visibleWidth(title));
    return `${left}${title}${theme.fg("border", RULE.repeat(room))}`;
  }

  private dots(): string {
    const { theme } = this.deps;
    if (this.deck.length === 1 || this.deck.length > MAX_DOTS) return "";
    const marks = this.deck.map((slot, place) => {
      if (place === this.at) return theme.fg("accent", "●");
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
    if (at === this.writeRow) return `${pointer}${this.writeIn(chosen, room)}`;
    const tag = at === 0 && this.choices.length > 1 ? ` ${RECOMMENDED}` : "";
    const text = this.fit(plain(label), room - visibleWidth(tag));
    const word = chosen ? theme.fg("accent", text) : text;
    return `${pointer}${word}${theme.fg("muted", tag)}`;
  }

  private writeIn(chosen: boolean, room: number): string {
    const { theme } = this.deps;
    const typed = this.input.getValue();
    if (chosen) return this.input.render(room)[0] ?? "";
    if (typed === "") return this.fit(WRITE_LABEL, room);
    return theme.fg("muted", this.fit(`${WRITE_LABEL} ${plain(typed)}`, room));
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
    const drafting = this.writing && this.words !== "";
    return [
      ["↑↓", `choose${this.place()}`],
      ...(this.open > 1 && !drafting ? [["←→", "decision"] as const] : []),
      ...this.enter(drafting),
      ...(drafting ? [] : [["type", "your own words"] as const]),
      ...(this.overflow ? [["PgUp/PgDn", "read"] as const] : []),
      ["esc", drafting ? "clear" : "later"],
    ];
  }

  private enter(drafting: boolean): (readonly [string, string])[] {
    if (drafting) return [["⏎", "send"]];
    return this.writing ? [] : [["⏎", "select"]];
  }

  private place(): string {
    const count = this.choices.length;
    return this.shownPicks < count ? ` ${String(this.row + 1)}/${String(count)}` : "";
  }
}

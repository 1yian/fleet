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
import { LATER_EXAMPLES, laidOut } from "@fleet/protocol";
import type { Decision } from "./decisions.ts";
import { bounded, hanging, packed, paragraphs, plain } from "./wrap.ts";

const WRITE_LABEL = "My words…";
const LATER_LABEL = "Later…";
const RECOMMENDED = "(recommended)";
const MAX_DOTS = 10;
const MAX_BODY_ROWS = 16;
const MIN_BODY_ROWS = 2;
const FRAME_ROWS = 3;
const OVERDRAW_ROWS = 1;
const TIGHTER_LIMITS = [2, 1];
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
  readonly later: (decision: Decision, said: string) => Promise<void>;
  readonly reload: () => Promise<readonly Decision[]>;
  readonly redraw: () => void;
  readonly close: () => void;
}

type Row = "option" | "words" | "later";

interface Slot {
  readonly decision: Decision;
  readonly answered: boolean;
}

interface Shape {
  readonly title: readonly string[];
  readonly note: readonly string[];
  readonly hints: number;
  readonly limit: number;
}

interface Layout extends Shape {
  readonly spacers: number;
  readonly body: number;
  readonly picks: number;
}

const chromeOf = (shape: Shape): number =>
  FRAME_ROWS + shape.title.length + shape.note.length + shape.hints;

const oneLine = (data: string): string =>
  data.includes(PASTE_START) ? data.replace(/\s*[\r\n]+\s*/g, " ") : data;

export class DecisionCard implements Component, Focusable {
  readonly capturesViewportInput = true;
  private deck: readonly Slot[];
  private at = 0;
  private row = 0;
  private scroll = 0;
  private choiceTop = 0;
  private firstPick = 0;
  private pickRows: readonly number[] = [];
  private shownChoices = 0;
  private inner = 80;
  private overflow = false;
  private sending = false;
  private note: string | undefined;
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

  invalidate(): void {
    this.input.invalidate();
    this.when.invalidate();
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
    const choice = this.pickRows[event.y - this.firstPick];
    if (choice === undefined) return undefined;
    this.row = choice;
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

  private heights(): number[] {
    return this.choices.map((_, at) => this.choiceLines(at, this.inner).length);
  }

  private window(picks: number): number {
    const heights = this.heights();
    const rowsFrom = (top: number): number =>
      heights.slice(top, this.row + 1).reduce((sum, each) => sum + each, 0);
    let top = Math.min(this.choiceTop, this.row);
    while (top < this.row && rowsFrom(top) > picks) top += 1;
    this.choiceTop = top;
    return top;
  }

  private page(step: number): void {
    this.scroll = Math.max(0, this.scroll + step * this.layout().body);
  }

  private confirm(): void {
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
    this.when.setValue("");
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
    const { kind } = this;
    const picked = kind === "option" ? this.choices[this.row] : undefined;
    this.deck = deck;
    this.at = Math.max(0, same !== -1 ? same : landing !== -1 ? landing : first);
    if (same === -1) this.settle();
    else this.row = this.follow(kind, picked);
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

  private shaped(limit: number): Shape {
    const { theme } = this.deps;
    const decision = this.current;
    const name = `c-${String(decision?.card ?? 0)} ${plain(decision?.title ?? "")}`;
    const title = bounded(name, this.inner, limit).map((row) => theme.fg("muted", row));
    const note =
      this.note === undefined
        ? []
        : bounded(this.note, this.inner, limit).map((row) => theme.fg("warning", row));
    return { title, note, hints: Math.min(limit, this.hintLines(true).length), limit };
  }

  private layout(): Layout {
    const heights = this.heights();
    const own = heights[this.row] ?? 1;
    const budget = this.deps.rows();
    const reach = budget + OVERDRAW_ROWS;
    let shape = this.shaped(Infinity);
    for (const limit of TIGHTER_LIMITS) {
      if (chromeOf(shape) + MIN_BODY_ROWS + own <= budget) break;
      shape = this.shaped(limit);
    }
    const chrome = chromeOf(shape);
    const free = budget - chrome;
    const wanted = heights.reduce((sum, each) => sum + each, 0);
    const owned = Math.min(own, Math.max(1, reach - chrome - 1));
    const picks = Math.min(wanted, Math.max(owned, free - MIN_BODY_ROWS));
    const left = free - picks;
    const spacers = Math.max(0, Math.min(SPACER_ROWS, left - MIN_BODY_ROWS));
    const body = Math.max(1, Math.min(MAX_BODY_ROWS, left - spacers));
    return { ...shape, spacers, body, picks };
  }

  render(width: number): string[] {
    const decision = this.current;
    if (decision === undefined) return [];
    this.inner = Math.max(1, width - 2 * PADDING);
    const { inner } = this;
    const { theme } = this.deps;
    const line = (text: string): string => `${margin}${text}`;
    const quiet = (text: string): string => line(theme.fg("muted", this.fit(text, inner)));
    const body = paragraphs(laidOut(decision.question), inner);
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
      ...layout.title.map(line),
      ...spacer(1),
      ...body.slice(top, top + rows).map(line),
      lower > 0 ? quiet(`▼ ${String(lower)} more lines, PgDn to read`) : "",
    ];
    this.firstPick = lines.length;
    const picks = this.choiceRows(inner, layout.picks);
    return [
      ...lines,
      ...picks.map(line),
      ...spacer(2),
      ...layout.note.map(line),
      ...this.hintLines(false).slice(0, layout.limit).map(line),
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
    const top = this.window(picks);
    const rows: string[] = [];
    const owners: number[] = [];
    let shown = 0;
    for (let at = top; at < this.choices.length; at += 1) {
      const lines = this.choiceLines(at, inner);
      if (rows.length > 0 && rows.length + lines.length > picks) break;
      const kept = lines.slice(0, picks - rows.length);
      rows.push(...kept);
      owners.push(...kept.map(() => at));
      shown += 1;
    }
    this.pickRows = owners;
    this.shownChoices = shown;
    return rows;
  }

  private choiceLines(at: number, inner: number): string[] {
    const { theme } = this.deps;
    const chosen = at === this.row;
    const pointer = chosen ? theme.fg("accent", POINTER) : " ".repeat(POINTER.length);
    const gutter = " ".repeat(POINTER.length);
    const room = Math.max(1, inner - POINTER.length);
    if (at === this.writeRow)
      return [`${pointer}${this.writeIn(chosen, room, this.input, WRITE_LABEL)}`];
    if (at === this.laterRow)
      return [`${pointer}${this.writeIn(chosen, room, this.when, LATER_LABEL)}`];
    const tag = at === 0 && this.choices.length > 1 ? ` ${RECOMMENDED}` : "";
    const label = plain(this.choices[at] ?? "");
    const rows = hanging(label, room, "", "");
    const tagged = tag !== "" && visibleWidth(rows.at(-1) ?? "") + visibleWidth(tag) <= room;
    const alone = tag !== "" && !tagged ? [tag.trimStart()] : [];
    const lines = rows.map((row, index) => {
      const word = chosen ? theme.fg("accent", row) : row;
      const suffix = tagged && index === rows.length - 1 ? theme.fg("muted", tag) : "";
      return `${index === 0 ? pointer : gutter}${word}${suffix}`;
    });
    return [...lines, ...alone.map((row) => `${gutter}${theme.fg("muted", row)}`)];
  }

  private writeIn(chosen: boolean, room: number, line: Input, label: string): string {
    const { theme } = this.deps;
    const typed = line.getValue();
    if (chosen) return line.render(room)[0] ?? "";
    if (typed === "") return this.fit(label, room);
    return theme.fg("muted", this.fit(`${label} ${plain(typed)}`, room));
  }

  private hintLines(widest: boolean): string[] {
    const { theme } = this.deps;
    if (this.sending) return [theme.fg("muted", "sending…")];
    const pieces = this.hints(widest).map(
      ([key, what]) => `${theme.fg("dim", key)}${theme.fg("muted", ` ${what}`)}`,
    );
    return packed(pieces, this.inner, "   ");
  }

  private hints(widest: boolean): (readonly [string, string])[] {
    const { drafting, kind } = this;
    return [
      ["↑↓", `choose${this.place(widest)}`],
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

  private place(widest: boolean): string {
    const count = this.choices.length;
    if (!widest && this.shownChoices >= count) return "";
    return ` ${String(widest ? count : this.row + 1)}/${String(count)}`;
  }
}

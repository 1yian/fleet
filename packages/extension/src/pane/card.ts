import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { LATER_EXAMPLES, laidOut } from "@fleet/protocol";
import { merged, openAway, type Slot } from "./deck.ts";
import type { Decision } from "./decisions.ts";
import { hintLines } from "./hints.ts";
import { choiceLines } from "./options.ts";
import { allocate, rowsInSight, windowTop, type Layout, type Shape } from "./layout.ts";
import { plain } from "./look.ts";
import { drawNothing } from "./rest.ts";
import { topRule } from "./rule.ts";
import { oneLine } from "./text.ts";
import { bounded, paragraphs } from "./wrap.ts";

const WRITE_LABEL = "My words…";
const LATER_LABEL = "Later…";
const PADDING = 1;
const RULE = "─";
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

export class DecisionCard implements Component, Focusable {
  readonly capturesViewportInput = true;
  private deck: readonly Slot[];
  private at = 0;
  private row = 0;
  private offset = 0;
  private scroll = 0;
  private choiceTop = 0;
  private firstPick = 0;
  private pickRows: readonly number[] = [];
  private pressed: number | undefined;
  private shownChoices = 0;
  private inner = 80;
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

  private pressedChoice(event: TuiMouseEvent): number | undefined {
    const clicking = event.type === "click";
    const choice =
      clicking && this.pressed !== undefined
        ? this.pressed
        : this.pickRows[event.y - this.firstPick];
    this.pressed = clicking ? undefined : choice;
    return choice;
  }

  private press(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click"))
      return undefined;
    if (event.type === "press") this.arrival = undefined;
    const clicking = event.type === "click";
    const choice = this.pressedChoice(event);
    if (choice === undefined) return undefined;
    this.point(choice);
    if (clicking && this.kind === "option") this.confirm();
    return { handled: true };
  }

  private cancel(): void {
    if (this.drafting) this.typed.setValue("");
    else this.deps.close();
  }

  private point(row: number): void {
    if (row !== this.row) this.offset = 0;
    this.row = row;
  }

  private move(step: number): void {
    const { hidden } = this.layout();
    const inside = Math.min(this.offset, hidden) + step;
    if (inside >= 0 && inside <= hidden) {
      this.offset = inside;
      return;
    }
    const count = this.choices.length;
    this.row = (this.row + step + count) % count;
    this.offset = step < 0 ? Infinity : 0;
  }

  private sideways(step: number, data: string): void {
    if (this.kind !== "option" && this.typed.getValue() !== "") this.typed.handleInput(data);
    else this.turn(step);
  }

  private type(data: string): void {
    const line = this.typed;
    const before = line.getValue();
    line.handleInput(oneLine(data));
    if (line.getValue() !== before && this.kind === "option") this.point(this.writeRow);
  }

  private turn(step: number): void {
    const to = openAway(this.deck, this.at, step);
    if (to === undefined) return;
    this.at = to;
    this.settle();
  }

  private heights(): number[] {
    return this.choices.map((_, at) => this.choiceLines(at, this.inner).length);
  }

  private window(picks: number): number {
    this.choiceTop = windowTop(this.heights(), this.row, this.choiceTop, picks);
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
    this.deps.reload().then(
      (fresh) => {
        this.sending = false;
        this.apply(fresh);
        this.arrival = undefined;
        this.note = plain(why);
        this.leaveIfClear();
      },
      () => {
        this.sending = false;
        this.note = plain(why);
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
    else if (this.current?.hold !== before?.hold) {
      this.row = this.follow(kind, picked);
      this.offset = 0;
    }
    if (next.arrival !== undefined) {
      this.arrival = next.arrival;
      this.note = undefined;
    }
  }

  private follow(kind: Row, picked: string | undefined): number {
    if (kind === "words") return this.writeRow;
    if (kind === "later") return this.laterRow;
    return Math.max(0, (this.current?.options ?? []).indexOf(picked ?? ""));
  }

  private settle(): void {
    this.row = 0;
    this.offset = 0;
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
    const warning = this.note ?? this.arrival;
    const note =
      warning === undefined
        ? []
        : bounded(warning, this.inner, limit).map((row) => theme.fg("warning", row));
    return { title, note, hints: Math.min(limit, this.hintsFor(true).length), limit };
  }

  private layout(): Layout {
    return allocate((limit) => this.shaped(limit), this.heights(), this.row, this.deps.rows());
  }

  render(width: number): string[] {
    this.inner = Math.max(1, width - 2 * PADDING);
    const { inner } = this;
    const { theme } = this.deps;
    const decision = this.current;
    if (this.clear || decision === undefined) return drawNothing(theme, this.top(width), width);
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
    const picks = this.choiceRows(inner, layout);
    return [
      ...lines,
      ...picks.map(line),
      ...spacer(2),
      ...layout.note.map(line),
      ...this.hintsFor(false, rowsInSight(layout, this.offset)).slice(0, layout.limit).map(line),
      theme.fg("border", RULE.repeat(width)),
    ];
  }

  private hintsFor(widest: boolean, reading = ""): string[] {
    const state = {
      sending: this.sending,
      kind: this.kind,
      drafting: this.drafting,
      open: this.open,
      overflow: this.overflow,
      choices: this.choices.length,
      row: this.row,
      shown: this.shownChoices,
      inner: this.inner,
    };
    return hintLines(this.deps.theme, state, widest, reading);
  }

  private fit(text: string, width: number): string {
    return stripTerminalSequences(truncateToWidth(text, width, "…"));
  }

  private top(width: number): string {
    return topRule(this.deps.theme, width, this.deck, this.at, this.clear);
  }

  private choiceRows(inner: number, layout: Layout): string[] {
    const { picks, hidden } = layout;
    const top = this.window(picks);
    const slid = Math.min(this.offset, hidden);
    const rows: string[] = [];
    const owners: number[] = [];
    let shown = 0;
    for (let at = top; at < this.choices.length; at += 1) {
      const scrolled = at === this.row && hidden > 0;
      const all = this.choiceLines(at, inner, scrolled ? slid : 0);
      const lines = scrolled ? all.slice(slid, slid + picks) : all;
      if (rows.length > 0 && rows.length + lines.length > picks) break;
      rows.push(...lines);
      owners.push(...lines.map(() => at));
      shown += 1;
    }
    this.pickRows = owners;
    this.shownChoices = shown;
    return rows;
  }

  private choiceLines(at: number, inner: number, pointed = 0): string[] {
    const { theme } = this.deps;
    const write = { line: this.input, label: WRITE_LABEL };
    const later = { line: this.when, label: LATER_LABEL };
    const rows = { theme, choices: this.choices, row: this.row, write, later };
    return choiceLines(rows, at, inner, pointed);
  }
}

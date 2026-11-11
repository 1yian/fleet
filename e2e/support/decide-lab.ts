import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CardSchema, check, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "./cardd.ts";
import { Harness } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { records } from "./json.ts";
import { configureMain, Scratch, startMain } from "./scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const EVIDENCE = process.env["DECIDE_EVIDENCE_DIR"];
const STRIP_ROW = /^[◆●◇] \D/;
const RULE = /^─{20,}$/;
export const CARD_TOP = /^── ◆ Decision \d+ of \d+/;
export const SHIP = "Ship the scrollbar fix?";
export const RENAME = "Rename the repository?";
export const MY_WORDS = "Keep the old name until the move in March";
export const SEEN = "I put it to you.";

export const showing =
  (shown: readonly string[], hidden: readonly string[] = []) =>
  (screen: string): boolean =>
    shown.every((text) => screen.includes(text)) && !hidden.some((text) => screen.includes(text));

export const rowsOf = (screen: string): string[] => screen.split("\n");
export const stripRow = (screen: string): number =>
  rowsOf(screen).findIndex((row) => STRIP_ROW.test(row.trim()));

export function cardRows(screen: string): string[] {
  const rows = rowsOf(screen).map((row) => row.trimEnd());
  const top = rows.findIndex((row) => CARD_TOP.test(row));
  const bottom = rows.findIndex((row, at) => at > top && RULE.test(row));
  if (top === -1 || bottom === -1) return [];
  return rows.slice(top, bottom + 1);
}

export const onCard =
  (shown: readonly string[], hidden: readonly string[] = []) =>
  (screen: string): boolean =>
    showing(shown, hidden)(cardRows(screen).join("\n"));

export function keep(name: string, screen: string): void {
  if (EVIDENCE === undefined) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, `${name}.txt`), screen);
}

export function inline(screen: string): void {
  const rows = rowsOf(screen).map((row) => row.trimEnd());
  const card = cardRows(screen);
  assert.ok(card.length > 0, `the card is on screen:\n${screen}`);
  assert.ok(
    card.every((row) => !/[│╭╮╰╯]/.test(row)),
    "the card draws no box and no floating border",
  );
  assert.equal(card[0]?.length, card.at(-1)?.length, "its rules span the same width");
  const top = rows.findIndex((row) => CARD_TOP.test(row));
  const footer = rows[top + card.length] ?? "";
  assert.match(footer, /1stmate/, "the footer sits right under the card, as under the editor");
  assert.ok(stripRow(screen) === -1, "the strip steps aside while the card is open");
}

export function optionAt(screen: string, label: string): { row: number; column: number } {
  const top = rowsOf(screen).findIndex((row) => CARD_TOP.test(row));
  const row = rowsOf(screen).findIndex((each, at) => at > top && each.includes(label));
  assert.ok(row > top, `${label} is on the card:\n${screen}`);
  return { row, column: (rowsOf(screen)[row]?.indexOf(label) ?? 0) + 1 };
}

const mouseAt = (row: number, column: number): string => `${String(column)};${String(row + 1)}`;

export class DecideLab {
  readonly cardd: Cardd;
  readonly h: Harness;
  readonly cleo: Session;
  private readonly scratch: Scratch;
  private opened: HerdrLab | undefined;

  private constructor(cardd: Cardd, h: Harness, scratch: Scratch, cleo: Session) {
    this.cardd = cardd;
    this.h = h;
    this.scratch = scratch;
    this.cleo = cleo;
  }

  static async start(): Promise<DecideLab> {
    const cardd = await Cardd.start();
    const h = await Harness.start();
    const scratch = new Scratch();
    configureMain(scratch, cardd.url, cardd.addLane("main", undefined, scratch.root));
    const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
    return new DecideLab(cardd, h, scratch, cleo);
  }

  async stop(t: object): Promise<void> {
    await this.opened?.printIfFailed(t);
    const stopped = await Promise.allSettled([
      this.cleo.close(),
      this.opened?.stop(),
      this.h.stop(),
      this.cardd.stop(),
    ]);
    this.scratch.dispose();
    const failed = stopped.find((result) => result.status === "rejected");
    if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
  }

  herdr(): HerdrLab {
    if (this.opened === undefined) throw new Error("the herdr lab is not open");
    return this.opened;
  }

  private async openLab(): Promise<HerdrLab> {
    this.opened = await HerdrLab.start({
      ...this.h.piEnv("mate"),
      FLEET_PANE_POLL_MS: "3600000",
      PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
    });
    return this.opened;
  }

  async openMain(): Promise<string> {
    return startMain(await this.openLab(), this.scratch, this.h);
  }

  async openShortMain(): Promise<string> {
    const lab = await this.openLab();
    const made = await lab.run([
      "workspace",
      "create",
      "--cwd",
      this.scratch.root,
      "--label",
      "1stmate",
      "--no-focus",
    ]);
    const root = String(records([made["root_pane"]])[0]?.["pane_id"]);
    await lab.run(["pane", "split", root, "--direction", "down", "--ratio", "0.65"]);
    await lab.run(["pane", "close", root]);
    return startMain(lab, this.scratch, this.h);
  }

  async screenWhere(pane: string, what: string, ready: (screen: string) => boolean) {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const screen = await this.herdr().screen(pane);
      if (ready(screen)) return screen;
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}:\n${screen}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async mousePress(pane: string, row: number, column: number): Promise<void> {
    await this.herdr().type(pane, `\u001b[<0;${mouseAt(row, column)}M`);
  }

  async mouseRelease(pane: string, row: number, column: number): Promise<void> {
    await this.herdr().type(pane, `\u001b[<0;${mouseAt(row, column)}m`);
  }

  async click(pane: string, row: number, column: number): Promise<void> {
    await this.mousePress(pane, row, column);
    await this.mouseRelease(pane, row, column);
  }

  answers(count: number): void {
    for (let each = 0; each < count; each += 1) this.h.onModel(() => ({ text: "Noted." }), "mate");
  }

  async askedMain(
    pane: string,
    title: string,
    question: string,
    options: string[],
    count: number,
  ): Promise<Card> {
    const card = check(CardSchema, await this.cleo.call("card.new", { title, kind: "scout" }));
    this.h.onModel(
      () => ({ tool: "hold", args: { card: card.id, question, options, to: "captain" } }),
      "mate",
    );
    this.h.onModel(() => ({ text: SEEN }), "mate");
    await this.cleo.call("hold", { card: card.id, question: `${title}?`, options: ["Yes"] });
    await this.screenWhere(pane, `${String(count)} on the strip`, showing([`◆ ${String(count)}`]));
    await this.h.waitForCall(count * 2 - 1, "mate", WAIT_MS);
    return card;
  }

  async answered(card: Card): Promise<{ body: string; source: unknown; written: unknown }[]> {
    const { entries } = await this.cardd.thread(card.id);
    return entries
      .filter((entry) => entry.kind === "answer")
      .map((entry) => ({
        body: entry.body,
        source: entry.fields["source"],
        written: entry.fields["written"],
      }));
  }

  async revisionOf(card: Card): Promise<number> {
    const found = (await this.cardd.board()).cards.find((each) => each.id === card.id);
    if (found === undefined) throw new Error(`c-${String(card.id)} is not on the board`);
    return found.revision;
  }

  async mainWasTold(index: number, card: Card, text: string): Promise<void> {
    const turns = await this.h.waitForCall(index, "mate", WAIT_MS);
    const last = turns.at(-1)?.text ?? "";
    assert.match(last, new RegExp(`^\\[fleet\\] captain on c-${String(card.id)} .*\\(answer\\): `));
    assert.ok(last.endsWith(text), `main was told: ${last}`);
  }
}

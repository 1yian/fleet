import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const EVIDENCE = process.env["DECIDE_EVIDENCE_DIR"];
const STRIP_ROW = /^[◆●◇] \D/;
const SHIP = "Ship the scrollbar fix?";
const RENAME = "Rename the repository?";
const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";
const MY_WORDS = "Keep the old name until the move in March";
const SEEN = "I put it to you.";

let cardd: Cardd;
let h: Harness;
let opened: HerdrLab | undefined;
let scratch: Scratch;
let cleo: Session;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  configureMain(scratch, cardd.url, cardd.addLane("main", undefined, scratch.root));
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
});
afterEach(async (t) => {
  await opened?.printIfFailed(t);
  const stopped = await Promise.allSettled([cleo.close(), opened?.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

function herdr(): HerdrLab {
  if (opened === undefined) throw new Error("the herdr lab is not open");
  return opened;
}

async function openLab(): Promise<HerdrLab> {
  opened = await HerdrLab.start({
    ...h.piEnv("mate"),
    FLEET_PANE_POLL_MS: "3600000",
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
  });
  return opened;
}

async function openMain(): Promise<string> {
  return startMain(await openLab(), scratch, h);
}

async function openShortMain(): Promise<string> {
  const lab = await openLab();
  const made = await lab.run([
    "workspace",
    "create",
    "--cwd",
    scratch.root,
    "--label",
    "1stmate",
    "--no-focus",
  ]);
  const root = String(records([made["root_pane"]])[0]?.["pane_id"]);
  await lab.run(["pane", "split", root, "--direction", "down", "--ratio", "0.65"]);
  await lab.run(["pane", "close", root]);
  return startMain(lab, scratch, h);
}

async function screenWhere(pane: string, what: string, ready: (screen: string) => boolean) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const screen = await herdr().screen(pane);
    if (ready(screen)) return screen;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}:\n${screen}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const showing =
  (shown: readonly string[], hidden: readonly string[] = []) =>
  (screen: string): boolean =>
    shown.every((text) => screen.includes(text)) && !hidden.some((text) => screen.includes(text));

const onCard =
  (shown: readonly string[], hidden: readonly string[] = []) =>
  (screen: string): boolean =>
    showing(shown, hidden)(cardRows(screen).join("\n"));

function keep(name: string, screen: string): void {
  if (EVIDENCE === undefined) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, `${name}.txt`), screen);
}

const rowsOf = (screen: string): string[] => screen.split("\n");
const stripRow = (screen: string): number =>
  rowsOf(screen).findIndex((row) => STRIP_ROW.test(row.trim()));

function cardRows(screen: string): string[] {
  const rows = rowsOf(screen);
  const top = rows.findIndex((row) => row.includes("╭"));
  const bottom = rows.findIndex((row) => row.includes("╰"));
  if (top === -1 || bottom < top) return [];
  const left = rows[top]?.indexOf("╭") ?? 0;
  const right = rows[top]?.indexOf("╮") ?? 0;
  return rows.slice(top, bottom + 1).map((row) => row.slice(left, right + 1).trimEnd());
}

async function click(pane: string, row: number, column: number): Promise<void> {
  const at = `${String(column)};${String(row + 1)}`;
  await herdr().type(pane, `\u001b[<0;${at}M\u001b[<0;${at}m`);
}

function answers(count: number): void {
  for (let each = 0; each < count; each += 1) h.onModel(() => ({ text: "Noted." }), "mate");
}

async function askedMain(
  pane: string,
  title: string,
  question: string,
  options: string[],
  count: number,
): Promise<Card> {
  const card = check(CardSchema, await cleo.call("card.new", { title, kind: "scout" }));
  h.onModel(
    () => ({ tool: "hold", args: { card: card.id, question, options, to: "captain" } }),
    "mate",
  );
  h.onModel(() => ({ text: SEEN }), "mate");
  await cleo.call("hold", { card: card.id, question: `${title}?`, options: ["Yes"] });
  await screenWhere(pane, `${String(count)} on the strip`, showing([`◆ ${String(count)}`]));
  await h.waitForCall(count * 2 - 1, "mate", WAIT_MS);
  return card;
}

async function answered(
  card: Card,
): Promise<{ body: string; source: unknown; written: unknown }[]> {
  const { entries } = await cardd.thread(card.id);
  return entries
    .filter((entry) => entry.kind === "answer")
    .map((entry) => ({
      body: entry.body,
      source: entry.fields["source"],
      written: entry.fields["written"],
    }));
}

async function mainWasTold(index: number, card: Card, text: string): Promise<void> {
  const turns = await h.waitForCall(index, "mate", WAIT_MS);
  const last = turns.at(-1)?.text ?? "";
  assert.match(last, new RegExp(`^\\[fleet\\] captain on c-${String(card.id)} .*\\(answer\\): `));
  assert.ok(last.endsWith(text), `main was told: ${last}`);
}

test("/d opens the decisions one at a time, esc leaves them, and an answer or the captain's own words reach main as the board's line", async () => {
  const pane = await openMain();
  const ship = await askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  const rename = await askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
  answers(4);

  const waiting = await screenWhere(pane, "both decisions on the strip", showing(["◆ 2", SEEN]));
  const row = stripRow(waiting);
  assert.ok(row >= 0, `no strip row:\n${waiting}`);
  assert.match(rowsOf(waiting)[row] ?? "", /\/d\s*$/, "the strip names /d");
  keep("1-strip", waiting);

  await herdr().submit(pane, "/d");
  const first = await screenWhere(
    pane,
    "the first decision",
    onCard(["Decision 1 of 2", SHIP, "Ship it", "Hold", "My words…", "esc later"], [RENAME]),
  );
  keep("2-first-decision", first);
  assert.ok(first.includes("recommended"), "the first option is the recommended one");
  const drawn = cardRows(first);
  assert.ok(drawn[0]?.startsWith("╭") && drawn.at(-1)?.startsWith("╰"), "the card has a border");

  await herdr().press(pane, "esc");
  await screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);
  assert.equal((await cardd.board()).holds.length, 2, "leaving it answers nothing");

  await herdr().submit(pane, "/d");
  const again = await screenWhere(
    pane,
    "the same decision again",
    onCard(["Decision 1 of 2", SHIP]),
  );
  assert.deepEqual(cardRows(again), drawn, "typing /d again resumes the same decision");

  await herdr().press(pane, "down", "enter");
  const second = await screenWhere(
    pane,
    "the second decision",
    onCard(["Decision 2 of 2", RENAME, "Rename", "Keep"], [SHIP]),
  );
  keep("3-second-decision", second);
  assert.deepEqual(await answered(ship), [{ body: "Hold", source: "pane", written: undefined }]);
  await mainWasTold(4, ship, "Hold");

  await herdr().press(pane, "down", "down", "enter");
  keep(
    "3b-my-words",
    await screenWhere(pane, "the box for his words", onCard(["Your words for", "⏎ send"])),
  );
  await herdr().submit(pane, MY_WORDS);
  const done = await screenWhere(
    pane,
    "the last answer to clear the card and the count",
    (screen) => cardRows(screen).length === 0 && showing(["✓ clear"], ["◆"])(screen),
  );
  keep("4-all-answered", done);
  assert.deepEqual(await answered(rename), [{ body: MY_WORDS, source: "pane", written: true }]);
  await mainWasTold(5, rename, MY_WORDS);
  assert.deepEqual((await cardd.board()).holds, []);

  await herdr().submit(pane, "/d");
  const none = await screenWhere(
    pane,
    "the notice",
    showing(["Nothing is waiting for your decision."]),
  );
  keep("5-none-waiting", none);
  assert.deepEqual(cardRows(none), []);
});

test("a click on the strip opens exactly the card that /d opens", async () => {
  const pane = await openMain();
  const ship = await askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  answers(2);
  const waiting = await screenWhere(pane, "the strip", showing(["◆ 1", SEEN]));
  const row = stripRow(waiting);
  assert.ok(row >= 0, `no strip row:\n${waiting}`);

  await herdr().submit(pane, "/d");
  const typed = cardRows(
    await screenWhere(pane, "the card for /d", onCard(["Decision 1 of 1", SHIP])),
  );
  await herdr().press(pane, "esc");
  await screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);

  const strip = stripRow(await herdr().screen(pane));
  assert.equal(strip, row, "the strip is where it was");
  await click(pane, strip, 6);
  const clicked = await screenWhere(
    pane,
    "the card for the click",
    onCard(["Decision 1 of 1", SHIP]),
  );
  keep("6-opened-by-click", clicked);
  assert.deepEqual(cardRows(clicked), typed, "the click shows what /d shows");
  assert.equal((await cardd.board()).holds.length, 1, "opening it answers nothing");

  await herdr().press(pane, "enter");
  await screenWhere(pane, "the answer", (screen) => cardRows(screen).length === 0);
  await mainWasTold(2, ship, "Ship it");
});

test("an answer to a decision that changed while the card was open is refused and the card moves on", async () => {
  const pane = await openMain();
  const ship = await askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  await askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
  answers(3);

  await herdr().submit(pane, "/d");
  await screenWhere(pane, "the first decision", onCard(["Decision 1 of 2", SHIP]));
  const open = (await cardd.board()).holds.find((each) => each.card === ship.id);
  assert.ok(open !== undefined, "the hold is open on the board");
  assert.equal(await cardd.act(ship.id, { kind: "answer", hold: open.hold, choice: "Hold" }), 200);

  await herdr().press(pane, "enter");
  const refused = await screenWhere(
    pane,
    "the refusal and the next decision",
    onCard(
      [`c-${String(ship.id)} changed since you looked`, "nothing was recorded", RENAME],
      [SHIP],
    ),
  );
  keep("7-stale-answer", refused);
  assert.deepEqual(await answered(ship), [{ body: "Hold", source: "board", written: undefined }]);
});

test("a question longer than the card scrolls with PgDn and PgUp, and the card says how much is below", async () => {
  const pane = await openMain();
  const middle = Array.from({ length: 38 }, (_, at) => `Item ${String(at + 1)} of the evidence`);
  const question = ["FIRST LINE", ...middle, "LAST LINE"].join("\n");
  await askedMain(pane, "Long question", question, ["Take all my recommendations"], 1);

  await herdr().submit(pane, "/d");
  const top = await screenWhere(
    pane,
    "the top of the question",
    onCard(["FIRST LINE", "more lines, PgDn to read", "PgUp/PgDn read"], ["LAST LINE"]),
  );
  keep("8-long-question-top", top);
  assert.ok(cardRows(top).length <= 30, "the card fits a short pane");

  await herdr().type(pane, PAGE_DOWN.repeat(3));
  const end = await screenWhere(
    pane,
    "the end of the question",
    onCard(["LAST LINE", "Take all my recommendations"], ["more lines", "FIRST LINE"]),
  );
  keep("8-long-question-end", end);

  await herdr().type(pane, PAGE_UP.repeat(3));
  await screenWhere(pane, "the top again", onCard(["FIRST LINE", "more lines"], ["LAST LINE"]));
});

const FOUR_WAYS = ["Ship it", "Hold", "Wait a week", "Drop it"];

const evidence = (tag: string): string =>
  [
    `${tag} FIRST LINE`,
    ...Array.from({ length: 12 }, (_, at) => `Item ${String(at + 1)} of the evidence`),
    `${tag} LAST LINE`,
  ].join("\n");

function insidePane(screen: string): void {
  const rows = rowsOf(screen.replace(/\n$/, ""));
  const top = rows.findIndex((row) => row.includes("╭"));
  const height = cardRows(screen).length;
  assert.ok(height > 0, `the whole card is on screen:\n${screen}`);
  assert.ok(top >= 1, "the card keeps its top margin");
  assert.ok(top + height <= rows.length - 1, "the card keeps its bottom margin");
}

test("in a 12-row pane the choices scroll with the selection and the box for his words fits", async () => {
  const pane = await openShortMain();
  const long = await askedMain(pane, "Long question", evidence("ONE"), FOUR_WAYS, 1);
  answers(1);

  await herdr().submit(pane, "/d");
  const first = await screenWhere(
    pane,
    "the card in the short pane",
    onCard(
      ["Decision 1 of 1", "ONE FIRST LINE", "▌ Ship it", "Wait a week", "esc later"],
      ["Drop it"],
    ),
  );
  keep("9-short-pane-first-choice", first);
  insidePane(first);

  await herdr().press(pane, "down", "down", "down");
  const fourth = await screenWhere(
    pane,
    "the fourth choice",
    onCard(["▌ Drop it", "4/5", "esc later"], ["Ship it", "My words"]),
  );
  keep("9-short-pane-fourth-choice", fourth);
  insidePane(fourth);

  await herdr().press(pane, "down");
  const last = await screenWhere(
    pane,
    "my words",
    onCard(["▌ My words…", "5/5", "esc later"], ["Ship it", "Hold"]),
  );
  insidePane(last);

  await herdr().press(pane, "enter");
  const writing = await screenWhere(
    pane,
    "the box for his words",
    onCard(["Your words for", "⏎ send"]),
  );
  keep("9-short-pane-my-words", writing);
  insidePane(writing);

  await herdr().press(pane, "esc", "up", "up", "enter");
  await screenWhere(pane, "the answer", (screen) => cardRows(screen).length === 0);
  assert.deepEqual(await answered(long), [
    { body: "Wait a week", source: "pane", written: undefined },
  ]);
  await mainWasTold(2, long, "Wait a week");
});

test("in a 12-row pane a refusal of his own words keeps the note and the next decision on screen", async () => {
  const pane = await openShortMain();
  const ship = await askedMain(pane, "Scrollbar fix", evidence("SHIP"), FOUR_WAYS, 1);
  await askedMain(pane, "Repository name", evidence("RENAME"), FOUR_WAYS, 2);
  answers(3);

  await herdr().submit(pane, "/d");
  await screenWhere(pane, "the first decision", onCard(["Decision 1 of 2", "SHIP FIRST LINE"]));
  await herdr().press(pane, "down", "down", "down", "down", "enter");
  await screenWhere(pane, "the box for his words", onCard(["Your words for", "⏎ send"]));
  const open = (await cardd.board()).holds.find((each) => each.card === ship.id);
  assert.ok(open !== undefined, "the hold is open on the board");
  assert.equal(await cardd.act(ship.id, { kind: "answer", hold: open.hold, choice: "Hold" }), 200);

  await herdr().submit(pane, MY_WORDS);
  const refused = await screenWhere(
    pane,
    "the refusal and the next decision",
    onCard(
      [
        `c-${String(ship.id)} changed since you looked`,
        "RENAME FIRST LINE",
        "▌ Ship it",
        "esc later",
      ],
      ["SHIP FIRST LINE"],
    ),
  );
  keep("10-short-pane-refused", refused);
  insidePane(refused);
  assert.deepEqual(await answered(ship), [{ body: "Hold", source: "board", written: undefined }]);
});

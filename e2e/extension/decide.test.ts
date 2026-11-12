import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  awaiting,
  awaitingAt,
  CARD_TOP,
  cardRows,
  DecideLab,
  inline,
  keep,
  MY_WORDS,
  NOTHING,
  onCard,
  RENAME,
  rowsOf,
  SEEN,
  SHIP,
  showing,
} from "../support/decide-lab.ts";

const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";

let lab: DecideLab;
beforeEach(async () => {
  lab = await DecideLab.start();
});
afterEach(async (t) => {
  await lab.stop(t);
});

test("/d opens the decisions one at a time, esc leaves them, and an answer or the captain's own words reach main as the board's line", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  const rename = await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
  lab.answers(4);

  const waiting = await lab.screenWhere(
    pane,
    "both decisions on the status bar",
    showing([awaiting(2), SEEN]),
  );
  awaitingAt(waiting);
  keep("1-status-bar", waiting);

  await lab.herdr().submit(pane, "/d");
  const first = await lab.screenWhere(
    pane,
    "the first decision",
    onCard(["Decision 1 of 2", SHIP, "Ship it", "Hold", "My words…", "esc close"], [RENAME]),
  );
  keep("2-first-decision", first);
  assert.ok(first.includes("recommended"), "the first option is the recommended one");
  const drawn = cardRows(first);
  inline(first);

  await lab.herdr().press(pane, "esc");
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);
  assert.equal((await lab.cardd.board()).holds.length, 2, "leaving it answers nothing");

  await lab.herdr().submit(pane, "/d");
  const again = await lab.screenWhere(
    pane,
    "the same decision again",
    onCard(["Decision 1 of 2", SHIP]),
  );
  assert.deepEqual(cardRows(again), drawn, "typing /d again resumes the same decision");

  await lab.herdr().press(pane, "down", "enter");
  const second = await lab.screenWhere(
    pane,
    "the second decision",
    onCard(["Decision 2 of 2", RENAME, "Rename", "Keep"], [SHIP]),
  );
  keep("3-second-decision", second);
  assert.deepEqual(await lab.answered(ship), [
    { body: "Hold", source: "pane", written: undefined },
  ]);
  await lab.mainWasTold(4, ship, "Hold");

  await lab.herdr().press(pane, "down", "down");
  await lab.screenWhere(pane, "the pointer on his words", onCard(["→ My words…", "esc close"]));
  await lab.herdr().type(pane, MY_WORDS);
  keep(
    "3b-my-words",
    await lab.screenWhere(
      pane,
      "his words on their own row",
      onCard([`→ ${MY_WORDS}`, "⏎ send", "esc clear"]),
    ),
  );
  await lab.herdr().press(pane, "enter");
  const done = await lab.screenWhere(
    pane,
    "the last answer to clear the card and the count",
    (screen) => cardRows(screen).length === 0 && showing(["board"], ["await"])(screen),
  );
  keep("4-all-answered", done);
  assert.deepEqual(await lab.answered(rename), [{ body: MY_WORDS, source: "pane", written: true }]);
  await lab.mainWasTold(5, rename, MY_WORDS);
  assert.deepEqual((await lab.cardd.board()).holds, []);

  await lab.herdr().submit(pane, "/d");
  const none = await lab.screenWhere(pane, "the card that says nothing waits", onCard([NOTHING]));
  keep("5-none-waiting", none);
  await lab.herdr().press(pane, "esc");
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);
});

test("a click on the decisions item opens exactly the card that /d opens", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  lab.answers(2);
  const waiting = await lab.screenWhere(pane, "the status bar", showing([awaiting(1), SEEN]));
  const item = awaitingAt(waiting);

  await lab.herdr().submit(pane, "/d");
  const typed = cardRows(
    await lab.screenWhere(pane, "the card for /d", onCard(["Decision 1 of 1", SHIP])),
  );
  await lab.herdr().press(pane, "esc");
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);

  const back = await lab.screenWhere(pane, "the item to stay", showing([awaiting(1)]));
  assert.deepEqual(awaitingAt(back), item, "the item is where it was");
  await lab.click(pane, item.row, item.column + 3);
  const clicked = await lab.screenWhere(
    pane,
    "the card for the click",
    onCard(["Decision 1 of 1", SHIP]),
  );
  keep("6-opened-by-click", clicked);
  assert.deepEqual(cardRows(clicked), typed, "the click shows what /d shows");
  assert.equal((await lab.cardd.board()).holds.length, 1, "opening it answers nothing");

  await lab.herdr().press(pane, "enter");
  await lab.screenWhere(pane, "the answer", (screen) => cardRows(screen).length === 0);
  await lab.mainWasTold(2, ship, "Ship it");
});

test("entries that land on the card while it is open do not refuse the answer", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  lab.answers(2);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the decision", onCard(["Decision 1 of 1", SHIP, "→ Ship it"]));
  const looked = await lab.revisionOf(ship);
  await lab.cleo.call("comment", { card: ship.id, text: "CI is green again." });
  await lab.cleo.call("comment", { card: ship.id, text: "The branch is rebased." });
  assert.ok((await lab.revisionOf(ship)) > looked, "the card moved on after he looked");

  await lab.herdr().press(pane, "enter");
  const done = await lab.screenWhere(
    pane,
    "the answer to be taken",
    (screen) => cardRows(screen).length === 0 && !screen.includes("nothing was recorded"),
  );
  keep("7a-unrelated-entries", done);
  assert.deepEqual(await lab.answered(ship), [
    { body: "Ship it", source: "pane", written: undefined },
  ]);
  await lab.mainWasTold(2, ship, "Ship it");
});

test("an answer to a decision that changed while the card was open is refused and the card moves on", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
  lab.answers(3);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the first decision", onCard(["Decision 1 of 2", SHIP]));
  const open = (await lab.cardd.board()).holds.find((each) => each.card === ship.id);
  assert.ok(open !== undefined, "the hold is open on the board");
  assert.equal(
    await lab.cardd.act(ship.id, {
      kind: "hold",
      hold: open.hold,
      said: "in 2 hours",
      zone: "UTC",
    }),
    200,
  );

  await lab.herdr().press(pane, "enter");
  const refused = await lab.screenWhere(
    pane,
    "the refusal and the next decision",
    onCard(
      [`c-${String(ship.id)} is no longer waiting for your answer`, "nothing was recorded", RENAME],
      [SHIP],
    ),
  );
  keep("7-stale-answer", refused);
  assert.deepEqual(await lab.answered(ship), []);
});

test("a question longer than the card scrolls with PgDn and PgUp, and the card says how much is below", async () => {
  const pane = await lab.openMain();
  const middle = Array.from({ length: 38 }, (_, at) => `Item ${String(at + 1)} of the evidence`);
  const question = ["FIRST LINE", ...middle, "LAST LINE"].join("\n");
  await lab.askedMain(pane, "Long question", question, ["Take all my recommendations"], 1);

  await lab.herdr().submit(pane, "/d");
  const top = await lab.screenWhere(
    pane,
    "the top of the question",
    onCard(["FIRST LINE", "more lines, PgDn to read", "PgUp/PgDn read"], ["LAST LINE"]),
  );
  keep("8-long-question-top", top);
  assert.ok(cardRows(top).length <= 30, "the card fits a short pane");

  await lab.herdr().type(pane, PAGE_DOWN.repeat(3));
  const end = await lab.screenWhere(
    pane,
    "the end of the question",
    onCard(["LAST LINE", "Take all my recommendations"], ["more lines", "FIRST LINE"]),
  );
  keep("8-long-question-end", end);

  await lab.herdr().type(pane, PAGE_UP.repeat(3));
  await lab.screenWhere(pane, "the top again", onCard(["FIRST LINE", "more lines"], ["LAST LINE"]));
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
  inline(screen);
  assert.ok(
    rows.findIndex((row) => CARD_TOP.test(row)) >= 1,
    "the card leaves a row of the chat above it",
  );
}

test("in a 12-row pane the choices scroll with the selection and his words fit on their row", async () => {
  const pane = await lab.openShortMain();
  const long = await lab.askedMain(pane, "Long question", evidence("ONE"), FOUR_WAYS, 1);
  lab.answers(1);

  await lab.herdr().submit(pane, "/d");
  const first = await lab.screenWhere(
    pane,
    "the card in the short pane",
    onCard(["Decision 1 of 1", "ONE FIRST LINE", "→ Ship it", "esc close"], ["Drop it"]),
  );
  keep("9-short-pane-first-choice", first);
  insidePane(first);

  await lab.herdr().press(pane, "down", "down", "down");
  const fourth = await lab.screenWhere(
    pane,
    "the fourth choice",
    onCard(["→ Drop it", "4/6", "esc close"], ["Ship it", "My words"]),
  );
  keep("9-short-pane-fourth-choice", fourth);
  insidePane(fourth);

  await lab.herdr().press(pane, "down");
  const last = await lab.screenWhere(
    pane,
    "my words",
    onCard(["→ My words…", "5/6", "esc close"], ["Ship it", "Hold"]),
  );
  insidePane(last);

  await lab.herdr().type(pane, MY_WORDS);
  const writing = await lab.screenWhere(
    pane,
    "his words on their row",
    onCard([`→ ${MY_WORDS}`, "⏎ send", "esc clear"]),
  );
  keep("9-short-pane-my-words", writing);
  insidePane(writing);

  await lab.herdr().press(pane, "esc", "up", "up", "enter");
  await lab.screenWhere(pane, "the answer", (screen) => cardRows(screen).length === 0);
  assert.deepEqual(await lab.answered(long), [
    { body: "Wait a week", source: "pane", written: undefined },
  ]);
  await lab.mainWasTold(2, long, "Wait a week");
});

test("in a 12-row pane a refusal of his own words keeps the note and the next decision on screen", async () => {
  const pane = await lab.openShortMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", evidence("SHIP"), FOUR_WAYS, 1);
  await lab.askedMain(pane, "Repository name", evidence("RENAME"), FOUR_WAYS, 2);
  lab.answers(3);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the first decision", onCard(["Decision 1 of 2", "SHIP FIRST LINE"]));
  await lab.herdr().press(pane, "down", "down", "down", "down");
  await lab.screenWhere(pane, "his words row", onCard(["→ My words…", "5/6"]));
  const open = (await lab.cardd.board()).holds.find((each) => each.card === ship.id);
  assert.ok(open !== undefined, "the hold is open on the board");
  assert.equal(
    await lab.cardd.act(ship.id, {
      kind: "hold",
      hold: open.hold,
      said: "in 2 hours",
      zone: "UTC",
    }),
    200,
  );

  await lab.herdr().submit(pane, MY_WORDS);
  const refused = await lab.screenWhere(
    pane,
    "the refusal and the next decision",
    onCard(
      [
        `c-${String(ship.id)} is no longer waiting for your answer`,
        "RENAME FIRST LINE",
        "→ Ship it",
        "esc close",
      ],
      ["SHIP FIRST LINE"],
    ),
  );
  keep("10-short-pane-refused", refused);
  insidePane(refused);
  assert.deepEqual(await lab.answered(ship), []);
});

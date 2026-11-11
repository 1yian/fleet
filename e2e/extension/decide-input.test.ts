import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  cardRows,
  DecideLab,
  inline,
  keep,
  MY_WORDS,
  onCard,
  optionAt,
  RENAME,
  SHIP,
  showing,
  stripRow,
} from "../support/decide-lab.ts";

const RENAMED = "Rename the repository to fleet-next?";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

let lab: DecideLab;
beforeEach(async () => {
  lab = await DecideLab.start();
});
afterEach(async (t) => {
  await lab.stop(t);
});

test("words typed straight onto the card are recorded as his own words, never as the highlighted choice", async () => {
  const pane = await lab.openMain();
  const rename = await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 1);
  lab.answers(2);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the decision", onCard(["Decision 1 of 1", RENAME, "→ Rename"]));
  await lab.herdr().type(pane, MY_WORDS);
  keep(
    "11-typed-straight-onto-the-card",
    await lab.screenWhere(
      pane,
      "his words on their own row",
      onCard([`→ ${MY_WORDS}`, "⏎ send"], ["→ Rename"]),
    ),
  );
  assert.equal((await lab.cardd.board()).holds.length, 1, "typing answers nothing");

  await lab.herdr().press(pane, "enter");
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);
  assert.deepEqual(await lab.answered(rename), [{ body: MY_WORDS, source: "pane", written: true }]);
  await lab.mainWasTold(2, rename, MY_WORDS);
});

test("a pasted paragraph becomes one line of his words", async () => {
  const pane = await lab.openMain();
  const rename = await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 1);
  lab.answers(2);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the decision", onCard(["Decision 1 of 1", RENAME]));
  await lab
    .herdr()
    .type(pane, `${PASTE_START}Keep the old name\nuntil the move in March\n${PASTE_END}`);
  await lab.screenWhere(
    pane,
    "the pasted words on one line",
    onCard(["→ Keep the old name until the move in March"]),
  );
  await lab.herdr().press(pane, "enter");
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);
  assert.deepEqual(await lab.answered(rename), [
    { body: "Keep the old name until the move in March", source: "pane", written: true },
  ]);
});

test("a refused answer that leaves the decision open keeps the words he typed", async () => {
  const pane = await lab.openMain();
  const rename = await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 1);
  lab.answers(3);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the decision", onCard(["Decision 1 of 1", RENAME]));
  await lab.herdr().type(pane, MY_WORDS);
  await lab.screenWhere(pane, "his words", onCard([`→ ${MY_WORDS}`]));
  await lab.cleo.call("hold", { card: rename.id, question: RENAMED, options: ["Rename", "Keep"] });

  await lab.herdr().press(pane, "enter");
  const refused = await lab.screenWhere(
    pane,
    "the refusal with his words still on the card",
    onCard([`c-${String(rename.id)} changed since you looked`, RENAMED, `→ ${MY_WORDS}`, "⏎ send"]),
  );
  keep("12-refused-keeps-words", refused);
  assert.deepEqual(await lab.answered(rename), []);

  await lab.herdr().press(pane, "enter");
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);
  assert.deepEqual(await lab.answered(rename), [{ body: MY_WORDS, source: "pane", written: true }]);
});

test("a refused answer that adds an option keeps the pointer on his words, and the retry records them", async () => {
  const pane = await lab.openMain();
  const rename = await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 1);
  lab.answers(3);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the decision", onCard(["Decision 1 of 1", RENAME]));
  await lab.herdr().type(pane, MY_WORDS);
  await lab.screenWhere(pane, "his words", onCard([`→ ${MY_WORDS}`]));
  await lab.cleo.call("hold", {
    card: rename.id,
    question: RENAMED,
    options: ["Rename", "Keep", "Postpone"],
  });

  await lab.herdr().press(pane, "enter");
  keep(
    "12-refused-new-option-keeps-pointer",
    await lab.screenWhere(
      pane,
      "the refusal with the new option listed and the pointer on his words",
      onCard(
        [`c-${String(rename.id)} changed since you looked`, "Postpone", `→ ${MY_WORDS}`, "⏎ send"],
        ["→ Postpone"],
      ),
    ),
  );
  assert.deepEqual(await lab.answered(rename), []);

  await lab.herdr().press(pane, "enter");
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);
  assert.deepEqual(await lab.answered(rename), [{ body: MY_WORDS, source: "pane", written: true }]);
});

const CLEAN = "Delete the merged branches?";

test("left and right move between the decisions without answering any, and answered ones are ticked", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  const rename = await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
  const clean = await lab.askedMain(pane, "Branch cleanup", CLEAN, ["Delete", "Keep"], 3);
  lab.answers(3);

  await lab.herdr().submit(pane, "/d");
  keep(
    "13-arrows-first",
    await lab.screenWhere(pane, "the first", onCard(["Decision 1 of 3", SHIP, "←→ decision"])),
  );
  await lab.herdr().press(pane, "right");
  keep(
    "13-arrows-second",
    await lab.screenWhere(pane, "the second", onCard(["Decision 2 of 3", RENAME], [SHIP])),
  );
  await lab.herdr().press(pane, "right");
  await lab.screenWhere(pane, "the third", onCard(["Decision 3 of 3", CLEAN], [RENAME]));
  await lab.herdr().press(pane, "right");
  await lab.screenWhere(pane, "the first again", onCard(["Decision 1 of 3", SHIP], [CLEAN]));
  await lab.herdr().press(pane, "left");
  await lab.screenWhere(pane, "the third again", onCard(["Decision 3 of 3", CLEAN], [SHIP]));
  await lab.herdr().press(pane, "left");
  await lab.screenWhere(pane, "the second again", onCard(["Decision 2 of 3", RENAME]));

  const board = await lab.cardd.board();
  assert.equal(board.holds.length, 3, "moving between them answers none");
  for (const card of [ship, rename, clean]) assert.deepEqual(await lab.answered(card), []);

  await lab.herdr().press(pane, "down", "enter");
  keep(
    "13-arrows-ticked",
    await lab.screenWhere(
      pane,
      "the third after the answer",
      onCard(["Decision 3 of 3", CLEAN, "○✓●"]),
    ),
  );
  assert.deepEqual(await lab.answered(rename), [
    { body: "Keep", source: "pane", written: undefined },
  ]);
  await lab.mainWasTold(6, rename, "Keep");

  await lab.herdr().press(pane, "right");
  await lab.screenWhere(
    pane,
    "the first, skipping the answered one",
    onCard(["Decision 1 of 3", SHIP, "●✓○"]),
  );
  await lab.herdr().press(pane, "right");
  await lab.screenWhere(
    pane,
    "the third, skipping the answered one",
    onCard(["Decision 3 of 3", CLEAN]),
  );
});

test("left and right move the cursor in his words while he is typing and never leave the decision", async () => {
  const pane = await lab.openMain();
  await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  const rename = await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
  lab.answers(3);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the first", onCard(["Decision 1 of 2", SHIP]));
  await lab.herdr().type(pane, "ac");
  await lab.herdr().press(pane, "left");
  await lab.herdr().type(pane, "b");
  await lab.screenWhere(pane, "the letter in the middle", onCard(["→ abc", "Decision 1 of 2"]));

  await lab.herdr().press(pane, "esc");
  await lab.herdr().press(pane, "right");
  await lab.screenWhere(pane, "the second decision", onCard(["Decision 2 of 2", RENAME], [SHIP]));
  assert.deepEqual(await lab.answered(rename), []);
});

test("a click on an option answers with it, and a click on My words only selects it", async () => {
  const pane = await lab.openMain();
  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  lab.answers(2);

  await lab.herdr().submit(pane, "/d");
  const first = await lab.screenWhere(
    pane,
    "the card",
    onCard(["Decision 1 of 1", SHIP, "→ Ship it"]),
  );
  const words = optionAt(first, "My words…");
  await lab.click(pane, words.row, words.column);
  const picked = await lab.screenWhere(
    pane,
    "the pointer on his words",
    onCard(["→ My words…"], ["→ Ship it"]),
  );
  keep("14-clicked-my-words", picked);
  assert.equal((await lab.cardd.board()).holds.length, 1, "a click on My words answers nothing");

  const hold = optionAt(picked, "Hold");
  await lab.mousePress(pane, hold.row, hold.column);
  await lab.screenWhere(pane, "the pointer under the mouse", onCard(["→ Hold"], ["→ My words…"]));
  assert.equal(
    (await lab.cardd.board()).holds.length,
    1,
    "pressing without releasing answers nothing",
  );
  await lab.mouseRelease(pane, hold.row, hold.column);
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);
  assert.deepEqual(await lab.answered(ship), [
    { body: "Hold", source: "pane", written: undefined },
  ]);
  await lab.mainWasTold(2, ship, "Hold");
});

test("the card takes the editor's place and gives it back with the words he had in it", async () => {
  const pane = await lab.openMain();
  await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  lab.answers(2);
  const DRAFT = "a half written message";

  await lab.herdr().type(pane, DRAFT);
  const waiting = await lab.screenWhere(pane, "the draft in the editor", showing([DRAFT]));
  await lab.click(pane, stripRow(waiting), 6);
  const open = await lab.screenWhere(
    pane,
    "the card in the editor's place",
    onCard(["Decision 1 of 1"], [DRAFT]),
  );
  inline(open);
  assert.ok(!open.includes(DRAFT), "the editor is not drawn under the card");

  await lab.herdr().press(pane, "esc");
  await lab.screenWhere(
    pane,
    "the editor back with his draft",
    (screen) => cardRows(screen).length === 0 && screen.includes(DRAFT),
  );
});

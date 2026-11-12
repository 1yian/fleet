import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  CARD_TOP,
  cardRows,
  DecideLab,
  keep,
  onCard,
  optionAt,
  rowsOf,
} from "../support/decide-lab.ts";

let lab: DecideLab;
beforeEach(async () => {
  lab = await DecideLab.start();
});
afterEach(async (t) => {
  await lab.stop(t);
});

const TITLE = "Repair the recording egress group: protect m405, corrected template roll-forward";
const LONG_OPTION = "Merge and roll it out in the staged window with a 60-minute recording watch";
const OTHER_OPTION = "Merge only, and start no deploy until the captain says so";
const QUESTION =
  "Merge https://github.com/acme/web/pull/2930 , and then roll it out? Two separate steps: 1. Merge: starts no deploy (egress deploy is manual only). Recommend yes. 2. Staged roll-forward in the 06:00-11:00Z window with a 60-minute recording watch. Recommend yes. Summary: p620:/tmp/fleet-c-1406/final-summary.md";

const squeezed = (text: string): string => text.replace(/\s+/g, "");

test("in a narrow pane the question, the title, the options, and the hints wrap at the pane width and nothing is cut off", async () => {
  const pane = await lab.openNarrowMain();
  const merge = await lab.askedMerge(
    pane,
    TITLE,
    {
      question: QUESTION,
      options: [LONG_OPTION, OTHER_OPTION],
      approves: [LONG_OPTION],
    },
    1,
  );
  lab.answers(2);

  await lab.herdr().submit(pane, "/d");
  const first = await lab.screenWhere(
    pane,
    "the card in the narrow pane",
    onCard(["Decision 1 of 1", "My words"]),
  );
  keep("12-narrow-pane", first);
  const rows = cardRows(first);
  const text = squeezed(rows.join("\n"));
  const width = Math.max(...rows.map((row) => row.length));
  assert.ok(width < 60, `the pane is narrow (${String(width)} columns):\n${first}`);
  assert.ok(
    !rows.some((row) => row.includes("…") && !row.includes("My words")),
    `a row is cut:\n${first}`,
  );
  for (const whole of [
    TITLE,
    LONG_OPTION,
    OTHER_OPTION,
    "Summary:p620:/tmp/fleet-c-1406/final-summary.md",
  ])
    assert.ok(text.includes(squeezed(whole)), `${whole} is whole on the card:\n${first}`);
  assert.ok(text.includes(squeezed("(recommended)")), `the recommendation tag is kept:\n${first}`);
  assert.ok(text.includes(squeezed("esc later")), `the hints are kept:\n${first}`);

  const words = optionAt(first, "My words…");
  await lab.click(pane, words.row, words.column);
  const writing = await lab.screenWhere(pane, "his words line selected", onCard(["→ My words…"]));
  assert.equal((await lab.cardd.board()).holds.length, 1, "a click on his words answers nothing");

  const tail = optionAt(writing, "until the captain says so");
  await lab.click(pane, tail.row, tail.column);
  await lab.screenWhere(pane, "the card to clear", (screen) => cardRows(screen).length === 0);
  assert.deepEqual(await lab.mergeAnswer(merge), {
    kind: "comment",
    body: OTHER_OPTION,
    choice: OTHER_OPTION,
    approved: undefined,
    source: "pane",
  });
});

const SHORT_OPTION = "Merge and roll it out in the staged window";
const PANE_ROWS = 12;
const FOOTER_ROWS = 3;

const lead = (text: string): string => text.split(" ").slice(0, 3).join(" ");

async function aimedAt(pane: string, what: string, shown: string): Promise<string> {
  const screen = await lab.screenWhere(pane, what, onCard([shown]));
  keep(`13-short-narrow-${what.replace(/\W+/g, "-")}`, screen);
  const rows = rowsOf(screen.replace(/\n$/, ""));
  const card = cardRows(screen);
  const top = rows.findIndex((row) => CARD_TOP.test(row));
  assert.ok(card.length > 0, `the card's top and bottom rules are both on screen:\n${screen}`);
  assert.equal(rows.length, PANE_ROWS, `the pane is ${String(PANE_ROWS)} rows:\n${screen}`);
  assert.ok(
    top + card.length + FOOTER_ROWS <= PANE_ROWS,
    `the card leaves the footer on screen:\n${screen}`,
  );
  assert.ok(top >= 1, `the card leaves a row of the chat above it:\n${screen}`);
  assert.match(rows.slice(top + card.length).join("\n"), /http:\/\/127\.0\.0\.1:\d+/);
  const text = squeezed(card.join("\n"));
  assert.ok(text.includes("↑↓choose"), `the hint row is kept:\n${screen}`);
  return screen;
}

test("in a pane that is short and narrow at once, the whole selected option stays on screen with the footer and the hints as the pointer walks the options", async () => {
  const pane = await lab.openShortNarrowMain();
  const merge = await lab.askedMerge(
    pane,
    TITLE,
    { question: QUESTION, options: [SHORT_OPTION, OTHER_OPTION], approves: [SHORT_OPTION] },
    1,
  );
  lab.answers(1);

  await lab.herdr().submit(pane, "/d");
  const walk: { keys: string[]; shown: string; whole: string[] }[] = [
    { keys: [], shown: lead(SHORT_OPTION), whole: [SHORT_OPTION, "(recommended)", "⏎ select"] },
    { keys: ["down"], shown: lead(OTHER_OPTION), whole: [OTHER_OPTION, "⏎ select"] },
    { keys: ["down"], shown: "My words…", whole: ["3/3"] },
    {
      keys: ["up", "up"],
      shown: lead(SHORT_OPTION),
      whole: [SHORT_OPTION, "(recommended)", "⏎ select"],
    },
  ];
  let screen = "";
  for (const step of walk) {
    if (step.keys.length > 0) await lab.herdr().press(pane, ...step.keys);
    screen = await aimedAt(pane, `${step.shown} selected`, `→ ${step.shown}`);
    const text = squeezed(cardRows(screen).join("\n"));
    assert.ok(
      text.includes(squeezed(`c-${String(merge.id)} Repair the recording`)),
      `the title is kept, cut with an ellipsis:\n${screen}`,
    );
    for (const part of step.whole)
      assert.ok(text.includes(squeezed(part)), `${part} is whole on the card:\n${screen}`);
  }

  const tail = optionAt(screen, "(recommended)");
  await lab.click(pane, tail.row, tail.column);
  await lab.screenWhere(pane, "the card to clear", (each) => cardRows(each).length === 0);
  assert.deepEqual(await lab.mergeAnswer(merge), {
    kind: "answer",
    body: SHORT_OPTION,
    choice: SHORT_OPTION,
    approved: true,
    source: "pane",
  });
});

const TALL_OPTION =
  "Merge and roll it out in the staged window with a 60-minute recording watch, then hand the dashboards to the on-call engineer";
const ROWS_CUE = /rows (\d+)-(\d+)\/(\d+)/;

function optionRows(screen: string): string[] {
  const card = cardRows(screen).map((row) => row.trim());
  const from = card.findIndex((row) => row.startsWith("▼")) + 1;
  const to = card.findIndex((row) => row.startsWith("↑↓"));
  return card.slice(from, to).map((row) => row.replace(/^→\s*/, ""));
}

test("an option taller than the short narrow pane can give scrolls inside itself row by row, and every row of it and its tag is reached", async () => {
  const pane = await lab.openShortNarrowMain();
  const merge = await lab.askedMerge(
    pane,
    TITLE,
    { question: QUESTION, options: [TALL_OPTION, OTHER_OPTION], approves: [TALL_OPTION] },
    1,
  );
  lab.answers(1);

  await lab.herdr().submit(pane, "/d");
  let screen = await aimedAt(pane, "the first rows of the tall option", "→ Merge and roll");
  const cue = ROWS_CUE.exec(cardRows(screen).join("\n"));
  assert.ok(cue !== null, `the hints say which rows of the option are shown:\n${screen}`);
  let [first, last] = [Number(cue[1]), Number(cue[2])];
  const total = Number(cue[3]);
  assert.equal(first, 1, `the option opens at its first row:\n${screen}`);
  assert.ok(total >= 3 && last < total, `the option is taller than its window:\n${screen}`);

  const seen: string[] = [];
  const take = (shot: string): void => {
    for (const row of optionRows(shot)) if (!seen.includes(row)) seen.push(row);
  };
  take(screen);
  while (last < total) {
    await lab.herdr().press(pane, "down");
    first += 1;
    last += 1;
    const rows = `rows ${String(first)}-${String(last)}/${String(total)}`;
    screen = await aimedAt(pane, `the tall option at ${rows}`, rows);
    take(screen);
  }
  assert.equal(
    squeezed(seen.join("")),
    squeezed(`${TALL_OPTION} (recommended)`),
    `every row of the option and its tag was on screen at some step:\n${seen.join("\n")}`,
  );

  await lab.herdr().press(pane, "down");
  await aimedAt(pane, "the next option", "→ Merge only, and");
  await lab.herdr().press(pane, "up");
  const back = `rows ${String(first)}-${String(last)}/${String(total)}`;
  screen = await aimedAt(pane, "the tall option from below, at its end", back);
  assert.ok(squeezed(screen).includes("(recommended)"), `its tag is on screen:\n${screen}`);

  const tag = optionAt(screen, "(recommended)");
  await lab.click(pane, tag.row, tag.column);
  await lab.screenWhere(pane, "the card to clear", (each) => cardRows(each).length === 0);
  assert.deepEqual(await lab.mergeAnswer(merge), {
    kind: "answer",
    body: TALL_OPTION,
    choice: TALL_OPTION,
    approved: true,
    source: "pane",
  });
});

const REFLOW_TITLE =
  "Repair the recording egress group: protect m405, corrected template roll-forward for the staged window";
const REFLOW_FIRST = "Merge and roll it out in the staged window";
const REFLOW_SECOND = "Merge only, start no deploy";

test("a press on an option reflows the card, and the release at the same place still answers that option", async () => {
  const pane = await lab.openMidNarrowMain();
  const merge = await lab.askedMerge(
    pane,
    REFLOW_TITLE,
    { question: QUESTION, options: [REFLOW_FIRST, REFLOW_SECOND], approves: [REFLOW_FIRST] },
    1,
  );
  lab.answers(1);

  await lab.herdr().submit(pane, "/d");
  const first = await lab.screenWhere(
    pane,
    "both options on the card",
    onCard(["Decision 1 of 1", "→ Merge and roll", "(recommended)", "Merge only"]),
  );
  keep("14-press-before-reflow", first);
  const second = optionAt(first, "Merge only");

  await lab.mousePress(pane, second.row, second.column);
  const pressed = await lab.screenWhere(
    pane,
    "the second option selected",
    onCard(["→ Merge only"]),
  );
  keep("14-press-after-reflow", pressed);
  assert.notEqual(
    optionAt(pressed, "Merge only").row,
    second.row,
    `pressing the option reflows the card, so it is no longer under the pointer:\n${pressed}`,
  );

  await lab.mouseRelease(pane, second.row, second.column);
  await lab.screenWhere(pane, "the card to clear", (screen) => cardRows(screen).length === 0);
  assert.deepEqual(await lab.mergeAnswer(merge), {
    kind: "comment",
    body: REFLOW_SECOND,
    choice: REFLOW_SECOND,
    approved: undefined,
    source: "pane",
  });
});

const PLAN_OPTION = "Merge and roll it out";
const PLAN_OTHER = "Merge only";

test("in a pane about 14 columns wide no row of the card is wider than the pane, and the hints and the tag are still whole", async () => {
  const pane = await lab.openVeryNarrowMain();
  const merge = await lab.askedMerge(
    pane,
    "Pick the plan",
    { question: "Merge it?", options: [PLAN_OPTION, PLAN_OTHER], approves: [PLAN_OPTION] },
    1,
  );
  lab.answers(1);

  await lab.herdr().submit(pane, "/d");
  const screen = await lab.screenWhere(
    pane,
    "the card in the very narrow pane",
    onCard(["My words", "esc"]),
  );
  keep("15-very-narrow-pane", screen);
  const rows = cardRows(screen);
  const width = rows.at(-1)?.length ?? 0;
  assert.ok(
    width > 0 && width <= 16,
    `the pane is very narrow (${String(width)} columns):\n${screen}`,
  );
  assert.deepEqual(
    rows.filter((row) => row.length > width),
    [],
    `no row is wider than the pane:\n${screen}`,
  );
  const text = squeezed(rows.join("\n"));
  for (const whole of [
    PLAN_OPTION,
    PLAN_OTHER,
    "(recommended)",
    "↑↓ choose",
    "⏎ select",
    "type your own words",
    "esc later",
  ])
    assert.ok(text.includes(squeezed(whole)), `${whole} is whole on the card:\n${screen}`);

  await lab.herdr().press(pane, "down", "enter");
  await lab.screenWhere(pane, "the card to clear", (each) => cardRows(each).length === 0);
  assert.equal((await lab.mergeAnswer(merge)).choice, PLAN_OTHER);
});

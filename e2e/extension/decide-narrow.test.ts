import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cardRows, DecideLab, keep, onCard } from "../support/decide-lab.ts";

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

  await lab.herdr().press(pane, "down", "enter");
  await lab.screenWhere(pane, "the card to clear", (screen) => cardRows(screen).length === 0);
  assert.deepEqual(await lab.mergeAnswer(merge), {
    kind: "comment",
    body: OTHER_OPTION,
    choice: OTHER_OPTION,
    approved: undefined,
    source: "pane",
  });
});

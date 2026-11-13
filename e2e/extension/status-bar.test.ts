import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check } from "@fleet/protocol";
import {
  awaiting,
  awaitingAt,
  cardRows,
  DecideLab,
  keep,
  NOTHING,
  onCard,
  RENAME,
  rowsOf,
  SHIP,
  showing,
  statusRow,
} from "../support/decide-lab.ts";
import { FakeOpener } from "../support/fake-opener.ts";
import { ageCard } from "../support/fleet.ts";

const WAIT_MS = 30_000;
const ESC = "\u001b";

let lab: DecideLab;
beforeEach(async () => {
  lab = await DecideLab.start();
});
afterEach(async (t) => {
  await lab.stop(t);
});

const boardUrl = (): string => lab.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");

function boardAt(screen: string): { row: number; column: number } {
  const row = rowsOf(screen).findIndex((each) => /\bboard\s*$/.test(each));
  assert.ok(row >= 0, `no board link on the status bar:\n${screen}`);
  return { row, column: (rowsOf(screen)[row]?.lastIndexOf("board") ?? 0) + 1 };
}

async function opened(opener: FakeOpener): Promise<string[]> {
  const deadline = Date.now() + WAIT_MS;
  while (opener.opened().length === 0) {
    assert.ok(Date.now() < deadline, "timed out waiting for the board to be opened");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return opener.opened();
}

for (const hyperlinks of ["1", "0"]) {
  test(`the status bar shows the word board and no URL, and a click on it opens the board (hyperlinks ${hyperlinks})`, async () => {
    const opener = new FakeOpener();
    const pane = await lab.openMain({ PI_HYPERLINKS: hyperlinks, PATH: opener.dir });
    const screen = await lab.screenWhere(pane, "the board link", showing(["board"]));
    keep(`board-hyperlinks-${hyperlinks}`, screen);
    assert.ok(!screen.includes("http"), `the status bar shows a URL:\n${screen}`);
    assert.ok(!screen.includes(new URL(boardUrl()).port), "the status bar shows the port");
    assert.match(statusRow(screen), /^board$/);

    const colored = await lab.herdr().coloredScreen(pane);
    keep(`board-hyperlinks-${hyperlinks}.ansi`, colored);
    const underlined = colored.split("\n").some((row) => {
      const from = row.lastIndexOf(`${ESC}[4m`);
      return from !== -1 && row.slice(from).includes("board");
    });
    assert.ok(underlined, "the word is underlined like a link");

    const link = boardAt(screen);
    assert.deepEqual(opener.opened(), []);
    await lab.click(pane, link.row, link.column + 2);
    assert.deepEqual(await opened(opener), [boardUrl()]);
  });
}

test("a click beside the word board opens nothing", async () => {
  const opener = new FakeOpener();
  const pane = await lab.openMain({ PI_HYPERLINKS: "0", PATH: opener.dir });
  const screen = await lab.screenWhere(pane, "the board link", showing(["board"]));
  const link = boardAt(screen);
  await lab.click(pane, link.row, link.column + "board".length + 4);
  await lab.click(pane, link.row - 1, link.column);
  await lab.click(pane, link.row, link.column + "board".length);
  assert.deepEqual(opener.opened(), []);
  await lab.click(pane, link.row, link.column);
  assert.deepEqual(await opened(opener), [boardUrl()]);
});

test("the decisions item is absent for none, singular for one, plural for several, and follows each answer", async () => {
  const pane = await lab.openMain();
  const clear = await lab.screenWhere(pane, "the clear state", showing(["board"], ["await"]));
  keep("1-none", clear);
  assert.equal(statusRow(clear), "board", "zero counts and the clear glyph are absent");

  const ship = await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  const one = await lab.screenWhere(pane, "one decision", showing([awaiting(1)], ["✓ clear"]));
  keep("2-one", one);
  assert.match(statusRow(one), /^1 decision awaits you board$/);

  const rename = await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
  lab.answers(2);
  const two = await lab.screenWhere(pane, "two decisions", showing([awaiting(2)]));
  keep("3-two", two);
  assert.match(statusRow(two), /^2 decisions await you board$/);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the card for every counted decision", onCard(["Decision 1 of 2"]));
  await lab.herdr().press(pane, "esc");
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);

  for (const [card, left] of [
    [ship, 1],
    [rename, 0],
  ] as const) {
    const open = (await lab.cardd.board()).holds.find((each) => each.card === card.id);
    assert.ok(open !== undefined, `the hold of c-${String(card.id)} is open`);
    assert.equal(
      await lab.cardd.act(card.id, { kind: "answer", hold: open.hold, choice: "Hold" }),
      200,
    );
    const shown = left === 0 ? showing(["board"], ["await"]) : showing([awaiting(left)]);
    keep(
      `4-answered-${String(left)}-left`,
      await lab.screenWhere(pane, `${String(left)} left`, shown),
    );
  }
});

test("answering on the card lowers the count behind it", async () => {
  const pane = await lab.openMain();
  await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
  lab.answers(2);

  await lab.herdr().submit(pane, "/d");
  const first = await lab.screenWhere(
    pane,
    "the first decision under two",
    (screen) => onCard(["Decision 1 of 2", SHIP])(screen) && screen.includes(awaiting(2)),
  );
  keep("5-card-over-two", first);
  await lab.herdr().press(pane, "enter");
  const second = await lab.screenWhere(
    pane,
    "the second decision under one",
    (screen) => onCard(["Decision 2 of 2", RENAME])(screen) && screen.includes(awaiting(1)),
  );
  keep("5-card-over-one", second);
});

const DAY_MS = 86_400_000;
const LATER_MS = 30_000;
const LATER = "in 30 seconds";
const VENDOR = "Pick the vendor?";

test("a card the captain put off is neither counted nor on /d until its date, however old the hold, and returns in both at its date", async () => {
  const pane = await lab.openMain();
  await lab.screenWhere(pane, "the clear state", showing(["board"]));
  const vendor = await lab.askedMain(pane, "Vendor", VENDOR, ["Acme", "Other"], 1);
  const date = Date.now() + LATER_MS;
  const open = (await lab.cardd.board()).holds.find((each) => each.card === vendor.id);
  assert.ok(open !== undefined, "the vendor decision is open");
  const action = {
    kind: "hold",
    hold: open.hold,
    said: LATER,
    zone: "UTC",
  } as const;
  assert.equal(await lab.cardd.act(vendor.id, action), 200);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the card that says nothing waits", onCard([NOTHING]));
  await lab.herdr().press(pane, "esc");
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);
  keep("6-put-off", await lab.screenWhere(pane, "no decision", showing(["board"], ["await"])));

  ageCard(lab.cardd, vendor, 6 * DAY_MS);
  await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 1);
  const one = await lab.screenWhere(pane, "only the new decision", showing([awaiting(1)]));
  keep("6-put-off-and-aged", one);
  assert.match(statusRow(one), /^1 decision awaits you board$/, "the put-off card is not counted");
  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the new decision alone", onCard(["Decision 1 of 1", RENAME]));
  await lab.herdr().press(pane, "esc");
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);
  assert.ok(Date.now() < date, "the date came before the checks above were done");

  const both = await lab.screenWhere(pane, "both decisions", showing([awaiting(2)]));
  assert.ok(Date.now() >= date, "the put-off card is counted before its date");
  keep("6-back-at-its-date", both);
  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the card for both", onCard(["Decision 1 of 2", RENAME]));
  await lab.herdr().press(pane, "right");
  await lab.screenWhere(pane, "the put-off one", onCard(["Decision 2 of 2", VENDOR]));
});

test("a card of the captain's own that he put off is neither counted nor on /d until its date, and returns in both at its date", async () => {
  const pane = await lab.openMain();
  await lab.screenWhere(pane, "the clear state", showing(["board"]));
  const own = await lab.askedMain(pane, "Vendor contract", VENDOR, ["Acme", "Other"], 1, "captain");
  const date = Date.now() + LATER_MS;
  const open = (await lab.cardd.board()).holds.find((each) => each.card === own.id);
  assert.ok(open !== undefined, "the decision on his own card is open");
  const action = {
    kind: "hold",
    hold: open.hold,
    said: LATER,
    zone: "UTC",
  } as const;
  assert.equal(await lab.cardd.act(own.id, action), 200);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the card that says nothing waits", onCard([NOTHING]));
  await lab.herdr().press(pane, "esc");
  await lab.screenWhere(pane, "the card to close", (screen) => cardRows(screen).length === 0);
  const screen = await lab.screenWhere(
    pane,
    "no decision and no count",
    showing(["board"], ["await", "◆"]),
  );
  keep("7-own-card-put-off", screen);
  assert.match(statusRow(screen), /^board$/);
  assert.ok(Date.now() < date, "the date came before the checks above were done");

  const back = await lab.screenWhere(pane, "the decision back", showing([awaiting(1)]));
  assert.ok(Date.now() >= date, "his own card is counted before its date");
  keep("7-own-card-back-at-its-date", back);
  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the card for his own card", onCard(["Decision 1 of 1", VENDOR]));
});

test("a Later made on the board lowers the count at once, with no /d and no poll", async () => {
  const pane = await lab.openMain();
  await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  const vendor = await lab.askedMain(pane, "Vendor", VENDOR, ["Acme", "Other"], 2);
  const open = (await lab.cardd.board()).holds.find((each) => each.card === vendor.id);
  assert.ok(open !== undefined, "the vendor decision is open");
  lab.answers(1);
  const action = { kind: "hold", hold: open.hold, said: "in 1 hour", zone: "UTC" } as const;
  assert.equal(await lab.cardd.act(vendor.id, action), 200);

  const one = await lab.screenWhere(pane, "only the other decision", showing([awaiting(1)]));
  assert.match(
    statusRow(one),
    /^1 decision awaits you board$/,
    "the put-off card is still counted",
  );
});

test("every count names the cards it counts, and his own tasks and landings are on no strip", async () => {
  const pane = await lab.openMain({ FLEET_PANE_POLL_MS: "400" });
  await lab.screenWhere(pane, "the board", showing(["board"]));
  await lab.cleo.call("card.new", { title: "Sign the contract", kind: "captain" });
  await lab.failedWorker("Fix the build");
  const idle = check(
    CardSchema,
    await lab.cleo.call("card.new", { title: "Read the invoices", kind: "scout" }),
  );
  ageCard(lab.cardd, idle, 5 * 3_600_000);
  await lab.landedCard("Check the budget");
  const screen = await lab.screenWhere(
    pane,
    "every count in words",
    showing(["1 broken card", "1 stalled card"]),
  );
  assert.equal(statusRow(screen), "1 broken card · 1 stalled card board");
  assert.doesNotMatch(statusRow(screen), /[●◆◇▲]|\b0\b|\byou(rs)?\b|landed/);
  keep("counts-in-words", screen);
  keep("counts-in-words.ansi", await lab.herdr().coloredScreen(pane));
});

const WIDTHS = [
  {
    columns: 66,
    ratio: 0.4,
    shown: "2 decisions await you · 1 broken card · 1 stalled card board",
  },
  { columns: 57, ratio: 0.5, shown: "2 decisions await you · 1 broken card · 1 stalled card" },
  { columns: 39, ratio: 0.65, shown: "2 decisions await you · 1 broken card" },
  { columns: 33, ratio: 0.7, shown: "2 decisions await you board" },
] as const;

for (const { columns, ratio, shown } of WIDTHS) {
  test(`at ${String(columns)} columns the status bar stays on one row, keeps the decisions first and still opens the card`, async () => {
    const pane = await lab.openMain({ FLEET_PANE_POLL_MS: "400" }, { direction: "right", ratio });
    await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
    await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
    await lab.failedWorker("Fix the Cleo rule");
    const idle = check(
      CardSchema,
      await lab.cleo.call("card.new", { title: "Read the invoices", kind: "scout" }),
    );
    ageCard(lab.cardd, idle, 5 * 3_600_000);
    lab.answers(2);

    const first = await lab.screenWhere(pane, "the decisions", showing([awaiting(2)]));
    const item = awaitingAt(first);
    await lab.click(pane, item.row, item.column);
    const screen = await lab.screenWhere(pane, "the card", onCard(["Decision 1 of 2"]));
    keep(`narrow-${String(columns)}`, screen);
    const row = statusRow(screen);
    assert.ok(row.length <= columns, `the status bar is wider than the pane: ${row}`);
    assert.equal(row, shown);
    assert.doesNotMatch(row, /[●◆◇▲]|\.\.\.|\b0\b/);
  });
}

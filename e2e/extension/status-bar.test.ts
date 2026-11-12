import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  awaiting,
  awaitingAt,
  cardRows,
  DecideLab,
  keep,
  onCard,
  RENAME,
  rowsOf,
  SHIP,
  showing,
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

const statusRow = (screen: string): string => {
  const rows = rowsOf(screen).map((row) => row.trimEnd());
  const at = rows.findLastIndex((row) => row !== "");
  return rows[at] ?? "";
};

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
    const screen = await lab.screenWhere(pane, "the board link", showing(["✓ clear", "board"]));
    keep(`board-hyperlinks-${hyperlinks}`, screen);
    assert.ok(!screen.includes("http"), `the status bar shows a URL:\n${screen}`);
    assert.ok(!screen.includes(new URL(boardUrl()).port), "the status bar shows the port");
    assert.match(statusRow(screen), /^✓ clear board$/);

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
  const screen = await lab.screenWhere(pane, "the board link", showing(["✓ clear", "board"]));
  const link = boardAt(screen);
  await lab.click(pane, link.row, link.column + "board".length + 4);
  await lab.click(pane, link.row - 1, link.column);
  await lab.click(pane, link.row, 1);
  assert.deepEqual(opener.opened(), []);
  await lab.click(pane, link.row, link.column);
  assert.deepEqual(await opened(opener), [boardUrl()]);
});

test("the decisions item is absent for none, singular for one, plural for several, and follows each answer", async () => {
  const pane = await lab.openMain();
  const clear = await lab.screenWhere(pane, "the clear state", showing(["✓ clear"], ["await"]));
  keep("1-none", clear);

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
    const shown = left === 0 ? showing(["✓ clear"], ["await"]) : showing([awaiting(left)]);
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
const VENDOR = "Pick the vendor?";

test("a card the captain put off is neither counted nor on /d until its date, however old the hold, and returns in both at its date", async () => {
  const pane = await lab.openMain();
  await lab.screenWhere(pane, "the clear state", showing(["✓ clear"]));
  const vendor = await lab.askedMain(pane, "Vendor", VENDOR, ["Acme", "Other"], 1);
  const date = Date.now() + LATER_MS;
  const open = (await lab.cardd.board()).holds.find((each) => each.card === vendor.id);
  assert.ok(open !== undefined, "the vendor decision is open");
  const action = {
    kind: "hold",
    hold: open.hold,
    until: date,
    reason: "ask me again after the launch",
  } as const;
  assert.equal(await lab.cardd.act(vendor.id, action), 200);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(
    pane,
    "nothing waiting",
    showing(["Nothing is waiting for your decision."]),
  );
  keep("6-put-off", await lab.screenWhere(pane, "no decision", showing(["✓ clear"], ["await"])));

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
  await lab.screenWhere(pane, "the clear state", showing(["✓ clear"]));
  const own = await lab.askedMain(pane, "Vendor contract", VENDOR, ["Acme", "Other"], 1, "captain");
  const date = Date.now() + LATER_MS;
  const open = (await lab.cardd.board()).holds.find((each) => each.card === own.id);
  assert.ok(open !== undefined, "the decision on his own card is open");
  const action = {
    kind: "hold",
    hold: open.hold,
    until: date,
    reason: "ask me again after the launch",
  } as const;
  assert.equal(await lab.cardd.act(own.id, action), 200);

  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(
    pane,
    "nothing waiting",
    showing(["Nothing is waiting for your decision."]),
  );
  const screen = await lab.screenWhere(
    pane,
    "no decision and no count",
    showing(["✓ clear"], ["await", "◆"]),
  );
  keep("7-own-card-put-off", screen);
  assert.match(statusRow(screen), /^✓ clear board$/);
  assert.ok(Date.now() < date, "the date came before the checks above were done");

  const back = await lab.screenWhere(pane, "the decision back", showing([awaiting(1)]));
  assert.ok(Date.now() >= date, "his own card is counted before its date");
  keep("7-own-card-back-at-its-date", back);
  await lab.herdr().submit(pane, "/d");
  await lab.screenWhere(pane, "the card for his own card", onCard(["Decision 1 of 1", VENDOR]));
});

const FULL = "2 decisions await you ● 1 ▲ 1 board";
const WIDTHS = [
  { columns: 57, ratio: 0.5 },
  { columns: 39, ratio: 0.65 },
  { columns: 33, ratio: 0.7 },
] as const;

for (const { columns, ratio } of WIDTHS) {
  test(`at ${String(columns)} columns the status bar stays on one row, keeps the decisions first and still opens the card`, async () => {
    const pane = await lab.openMain({ FLEET_PANE_POLL_MS: "400" }, { direction: "right", ratio });
    await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
    await lab.askedMain(pane, "Repository name", RENAME, ["Rename", "Keep"], 2);
    await lab.failedWorker("Fix the Cleo rule");
    await lab.landedCard("Check the ads budget");
    lab.answers(2);

    const screen = await lab.screenWhere(
      pane,
      "the whole status",
      showing([awaiting(2), "● 1"].slice(0, columns > awaiting(2).length + 4 ? 2 : 1)),
    );
    keep(`narrow-${String(columns)}`, screen);
    const row = statusRow(screen);
    assert.ok(row.length <= columns, `the status bar is wider than the pane: ${row}`);
    assert.ok(row.startsWith(awaiting(2)), `the decisions are not first: ${row}`);
    if (FULL.length <= columns) assert.equal(row, FULL);
    else assert.ok(FULL.startsWith(row.replace(/\.*$/, "")), `the cut row is not a prefix: ${row}`);

    const item = awaitingAt(screen);
    await lab.click(pane, item.row, item.column);
    await lab.screenWhere(pane, "the card", onCard(["Decision 1 of 2"]));
  });
}

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS } from "@fleet/protocol";
import {
  awaiting,
  awaitingAt,
  DecideLab,
  keep,
  onCard,
  rowsOf,
  SHIP,
  showing,
  statusRow,
} from "../support/decide-lab.ts";
import { FakeElement } from "../support/fake-element.ts";
import { FakeOpener } from "../support/fake-opener.ts";
import { ageCard, ageSession, begin } from "../support/fleet.ts";
import { HerdrClient, type Cell } from "../support/herdr-client.ts";

const WAIT_MS = 30_000;
const HOUR_MS = 3_600_000;
const WIDE = { rows: 40, columns: 160 };

let lab: DecideLab;
let client: HerdrClient | undefined;
beforeEach(async () => {
  lab = await DecideLab.start();
});
afterEach(async (t) => {
  client?.stop();
  client = undefined;
  await lab.stop(t);
});

const boardUrl = (): string => lab.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");

function cellOf(screen: string, text: string): Cell {
  const rows = rowsOf(screen);
  const row = rows.findLastIndex((each) => each.includes(text));
  assert.ok(row >= 0, `${text} is not on the screen:\n${screen}`);
  return { row, column: (rows[row]?.lastIndexOf(text) ?? 0) + 1 };
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!done()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function attached(pane: string, shown: string, size = WIDE): Promise<string> {
  client = await HerdrClient.start(lab.herdr(), pane, "board", {}, size);
  return lab.screenWhere(pane, `${shown} after the client attached`, showing([shown]));
}

for (const hyperlinks of ["1", "0"]) {
  test(`a plain click on board opens it through Element on the captain's side and not on the host (hyperlinks ${hyperlinks})`, async () => {
    const element = new FakeElement();
    const host = new FakeOpener();
    const pane = await lab.openMain({
      PI_HYPERLINKS: hyperlinks,
      PATH: host.dir,
      ELEMENT_HOME: element.home,
    });
    await lab.screenWhere(pane, "the board link", showing(["board"]));
    const screen = await attached(pane, "board", { rows: 30, columns: 120 });
    keep(`click-board-hyperlinks-${hyperlinks}`, screen);

    const at = cellOf(screen, "board");
    await client?.click(pane, { row: at.row, column: at.column + 2 });
    await until(() => element.opened().length > 0, "Element to be asked to open the board");
    assert.deepEqual(element.opened(), [boardUrl()]);
    assert.deepEqual(host.opened(), [], "the host's own opener was not used");
  });
}

test("a disconnected browser explains how to connect Element, never opens on the host, and a retry works", async () => {
  const element = new FakeElement(1);
  const host = new FakeOpener();
  const pane = await lab.openMain({ PATH: host.dir, ELEMENT_HOME: element.home });
  await lab.screenWhere(pane, "the board link", showing(["board"]));
  const screen = await attached(pane, "board", { rows: 30, columns: 120 });

  const at = cellOf(screen, "board");
  await client?.click(pane, { row: at.row, column: at.column + 2 });
  await lab.screenWhere(
    pane,
    "the browser connection instruction",
    showing(["Could not open", "browser extension", "click again"]),
  );
  assert.deepEqual(host.opened(), [], "failure must not open a browser on the pane host");
  assert.deepEqual(element.opened(), [boardUrl()]);
  element.exitCode = 0;
  const retry = cellOf(await lab.herdr().screen(pane), "board");
  await client?.click(pane, { row: retry.row - 1, column: retry.column });
  await client?.click(pane, { row: retry.row, column: retry.column + 2 });
  await until(() => element.opened().length === 2, "the connected browser to open on retry");
  assert.deepEqual(element.opened(), [boardUrl(), boardUrl()]);
  assert.deepEqual(host.opened(), []);
});

test("a ctrl-click on the linked board is herdr's own and opens it on the machine of the client", async () => {
  const element = new FakeElement();
  const host = new FakeOpener();
  const there = new FakeOpener();
  const pane = await lab.openMain({
    PI_HYPERLINKS: "1",
    PATH: host.dir,
    ELEMENT_HOME: element.home,
  });
  await lab.screenWhere(pane, "the board link", showing(["board"]));
  client = await HerdrClient.start(
    lab.herdr(),
    pane,
    "board",
    { PATH: there.dir },
    { rows: 30, columns: 120 },
  );
  const screen = await lab.screenWhere(pane, "the board link", showing(["board"]));

  const at = cellOf(screen, "board");
  await client.click(pane, { row: at.row, column: at.column + 2 }, "ctrl");
  await until(() => there.opened().length > 0, "the client's opener to be asked");
  assert.deepEqual(there.opened(), [boardUrl()]);
  assert.deepEqual(host.opened(), []);
  assert.deepEqual(element.opened(), []);
});

test("a plain click on the decisions item through a real herdr client opens the decision card", async () => {
  const pane = await lab.openMain();
  await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
  const screen = await attached(pane, awaiting(1), { rows: 30, columns: 120 });

  const item = awaitingAt(screen);
  await client?.click(pane, { row: item.row, column: item.column + 3 });
  await lab.screenWhere(pane, "the card", onCard(["Decision 1 of 1", SHIP]));
});

const OWN = ["Sign the contract", "Renew the passport"];
const BROKEN = ["Fix the build", "Fix the deploy"];
const STALLED = ["Read the invoices", "Sort the receipts"];
const LANDED = ["Check the budget", "Check the ledger"];
const EVERYTHING = [...OWN, ...BROKEN, ...STALLED, ...LANDED];

const overlayOf = (screen: string): string[] => {
  const rows = rowsOf(screen);
  const top = rows.findIndex((row) => row.includes("╭─"));
  const bottom = rows.findIndex((row, at) => at > top && row.includes("╰"));
  return top === -1 || bottom === -1 ? [] : rows.slice(top, bottom + 1);
};

const COUNTS = [
  { text: "2 broken cards", cards: BROKEN },
  { text: "2 stalled cards", cards: STALLED },
] as const;

async function openedList(pane: string, text: string): Promise<string> {
  const at = cellOf(await lab.herdr().screen(pane), text);
  await client?.click(pane, { row: at.row, column: at.column + 2 });
  const listed = await lab.screenWhere(pane, `the list of ${text}`, (screen) =>
    overlayOf(screen).some((each) => each.includes(text)),
  );
  keep(`click-counts-${text.replaceAll(" ", "-")}`, listed);
  return overlayOf(listed).join("\n");
}

function assertExactly(overlay: string, text: string, cards: readonly string[]): void {
  for (const title of cards) assert.ok(overlay.includes(title), `${title} is not in:\n${overlay}`);
  const others = EVERYTHING.filter((each) => !cards.includes(each));
  for (const title of others)
    assert.ok(!overlay.includes(title), `${title} is in the list of ${text}:\n${overlay}`);
  assert.equal(overlay.match(/c-\d+/g)?.length, cards.length, `the rows of ${text}:\n${overlay}`);
}

test("armed watches and live long jobs never count as stalled, and the count opens only unattended work", async () => {
  const make = async (title: string) =>
    check(CardSchema, await lab.cleo.call("card.new", { title, kind: "scout", project: "web" }));
  const busy = await make("Live ad watch");
  const worker = await lab.cardd.connect(await begin(lab.cleo, busy));
  const { job, heartbeatMs } = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "ad watch", command: "watch ads" }),
  );
  const beat = setInterval(() => {
    worker.call("job.alive", { job }).catch(() => undefined);
  }, heartbeatMs);
  try {
    worker.send({ t: "activity", state: "running" });
    await worker.call("standing", {});
    ageSession(lab.cardd, busy, 10 * 60_000);
    for (const [title, wait] of [
      ["Watched checkpoint", { watcher: "the scheduled CNP sweep checks the review" }],
      ["Outside checkpoint", { outside: "the EIN appointment" }],
    ] as const) {
      const held = await make(title);
      await lab.cleo.call("hold", {
        card: held.id,
        question: "Wait for the checkpoint",
        until: Date.now() + 10 * 24 * HOUR_MS,
        remaining: [],
        ...wait,
      });
      ageCard(lab.cardd, held, 45 * HOUR_MS);
    }
    const idle = await make("Unattended invoices");
    ageCard(lab.cardd, idle, 5 * HOUR_MS);
    const pane = await lab.openMain({ FLEET_PANE_POLL_MS: "400" });
    const counted = await lab.screenWhere(pane, "one unattended card", (screen) =>
      /\b\d+ stalled cards?\b/.test(screen),
    );
    keep("stalled-unattended-one", counted);
    assert.equal(statusRow(counted), "1 stalled card board", counted);
    const attachedScreen = await attached(pane, "1 stalled card");
    assert.equal(statusRow(attachedScreen), "1 stalled card board", attachedScreen);
    const overlay = await openedList(pane, "1 stalled card");
    assert.ok(overlay.includes("Unattended invoices"), overlay);
    assert.equal(overlay.match(/c-\d+/g)?.length, 1, overlay);
    for (const title of ["Live ad watch", "Watched checkpoint", "Outside checkpoint"])
      assert.ok(!overlay.includes(title), overlay);
    await lab.herdr().press(pane, "esc");
    await lab.cleo.call("hold", {
      card: idle.id,
      question: "Wait for the outside checkpoint",
      until: Date.now() + HOUR_MS,
      outside: "the invoice release date",
      remaining: [],
    });
    const cleared = await lab.screenWhere(
      pane,
      "no unattended cards",
      (screen) => statusRow(screen) === "board",
    );
    keep("stalled-watchers-cleared", cleared);
  } finally {
    clearInterval(beat);
    await worker.close();
  }
});

test("each count opens the list of exactly the cards it counts, and his own tasks and landings are on no strip, through a real herdr client", async () => {
  const pane = await lab.openMain({ FLEET_PANE_POLL_MS: "400" });
  await lab.screenWhere(pane, "the board", showing(["board"]));
  for (const title of OWN) await lab.cleo.call("card.new", { title, kind: "captain" });
  for (const title of BROKEN) await lab.failedWorker(title);
  for (const title of STALLED) {
    const idle = check(CardSchema, await lab.cleo.call("card.new", { title, kind: "scout" }));
    ageCard(lab.cardd, idle, 5 * HOUR_MS);
  }
  for (const title of LANDED) await lab.landedCard(title);
  const everything = await attached(pane, "2 stalled cards");
  keep("click-counts-status", everything);
  assert.equal(statusRow(everything), "2 broken cards · 2 stalled cards board");

  for (const { text, cards } of COUNTS) {
    assertExactly(await openedList(pane, text), text, cards);
    await lab.herdr().press(pane, "esc");
    await lab.screenWhere(pane, "the list to close", (screen) => overlayOf(screen).length === 0);
  }
});

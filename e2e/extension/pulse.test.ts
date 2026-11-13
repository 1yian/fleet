import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { ageCard, oldDatedHold } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const EVIDENCE = process.env["PANE_EVIDENCE_DIR"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let cardd: Cardd;
let h: Harness;
let opened: HerdrLab | undefined;
let scratch: Scratch;
let cleo: Session;
const workers: Session[] = [];
beforeEach(async () => {
  cardd = await Cardd.start();
  cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
  h = await Harness.start();
  scratch = new Scratch();
  configureMain(scratch, cardd.url, cardd.addLane("main", undefined, scratch.root));
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
});
afterEach(async (t) => {
  await opened?.printIfFailed(t);
  const stopped = await Promise.allSettled([
    ...workers.splice(0).map((worker) => worker.close()),
    cleo.close(),
    opened?.stop(),
    h.stop(),
    cardd.stop(),
  ]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

function herdr(): HerdrLab {
  if (opened === undefined) throw new Error("the herdr lab is not open");
  return opened;
}

async function openMain(): Promise<string> {
  opened = await HerdrLab.start({
    ...h.piEnv("mate"),
    FLEET_PANE_POLL_MS: "3600000",
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
  });
  const pane = await startMain(opened, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to connect");
  return pane;
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

function keep(name: string, screen: string): void {
  if (EVIDENCE === undefined) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, `${name}.txt`), screen);
}

async function card(title: string, kind: Card["kind"] = "scout"): Promise<Card> {
  const made = await cleo.call("card.new", { title, kind, project: "web" });
  return check(CardSchema, made);
}

async function running(title: string): Promise<void> {
  const made = await card(title);
  const attempt = await cleo.call("attempt.begin", {
    card: made.id,
    host: "maverick",
    task: "the task",
  });
  const worker = await cardd.connect(check(OPS["attempt.begin"].result, attempt).token);
  worker.send({ t: "activity", state: "running" });
  workers.push(worker);
}

const at = (screen: string, text: string): number => {
  const found = screen.indexOf(text);
  assert.ok(found >= 0, `${text} is not on the screen:\n${screen}`);
  return found;
};

test("/pulse lists the neglected cards first, quiet first, with running cards in one line, and it never reaches the chat or the model", async () => {
  const parked = await card("Crud ingress bypasses Cloud Armor");
  await cleo.call("hold", {
    card: parked.id,
    question: "Wait for the first hub use?",
    until: Date.now() + 10 * DAY,
    outside: "the first real support hub interaction",
    remaining: [],
  });
  ageCard(cardd, parked, 4 * DAY);
  const idle = await card("Port the invoices");
  ageCard(cardd, idle, 5 * HOUR);
  const yours = await card("Bitwarden login for the p620 browser", "captain");
  await running("Ship the scrollbar fix");
  await running("Fix the Cleo rule");
  const pane = await openMain();
  await screenWhere(pane, "the pane to count the broken and the stalled card", (screen) =>
    screen.includes("1 broken card · 1 stalled card board"),
  );

  await herdr().submit(pane, "/pulse");
  const opened = await screenWhere(pane, "the overlay", (screen) =>
    screen.includes("Pulse · 5 open · quiet first"),
  );
  keep("pulse-1-collapsed", opened);

  const order = [
    `PARKED 4d`,
    `c-${String(parked.id)}`,
    "Crud ingress bypasses Cloud Armor",
    "waits on an outside date: the first real support hub interaction",
    "IDLE 5h",
    "Port the invoices",
    "waits on cleo",
    `YOU`,
    "Bitwarden login for the p620 browser",
    "2 running",
  ];
  let last = -1;
  for (const text of order) {
    const found = at(opened, text);
    assert.ok(found > last, `${text} is out of order:\n${opened}`);
    last = found;
  }
  assert.ok(opened.includes("main · running nothing · moved 4d ago"), opened);
  assert.ok(!opened.includes("Ship the scrollbar fix"), "a running card is collapsed");
  assert.ok(!opened.includes("Fix the Cleo rule"), "a running card is collapsed");
  assert.ok(opened.includes("⏎ expand"));
  assert.equal(
    opened.split("\n").filter((row) => row.includes(`c-${String(yours.id)}`)).length,
    1,
    "a card the captain owns is one head row",
  );

  await herdr().press(pane, "down");
  await herdr().press(pane, "down");
  await herdr().press(pane, "down");
  await herdr().press(pane, "enter");
  const expanded = await screenWhere(pane, "the running cards", (screen) =>
    screen.includes("Ship the scrollbar fix"),
  );
  keep("pulse-2-expanded", expanded);
  assert.ok(expanded.includes("Fix the Cleo rule"));
  assert.ok(expanded.includes("⏎ collapse"));

  await herdr().press(pane, "escape");
  const closed = await screenWhere(
    pane,
    "the overlay to close",
    (screen) => !screen.includes("quiet first"),
  );
  keep("pulse-3-closed", closed);
  assert.ok(!closed.includes("PARKED"), "the list does not stay in the chat");
  assert.ok(!(await herdr().history(pane)).includes("PARKED"), "the list is not in the history");
  const context = h
    .callsOf("mate")
    .flat(2)
    .map((turn) => `${turn.role}: ${turn.text}`)
    .join("\n");
  for (const text of ["quiet first", "PARKED", "IDLE 5h", "2 running", "⏎"])
    assert.ok(!context.includes(text), `the model's context holds ${text}:\n${context}`);
});

test("a Needs you row shows when the card last moved and the steps behind it, also for a captain hold whose date has passed", async () => {
  const step = await card("Capacity proof");
  const asked = await card("Pick the vendor");
  oldDatedHold(cardd, asked, "captain", Date.now(), Date.now() - 1_000, [step.id]);
  ageCard(cardd, asked, 5 * HOUR);
  const pane = await openMain();
  await screenWhere(pane, "the pane to count the decision", (screen) =>
    screen.includes("1 decision awaits you"),
  );

  await herdr().submit(pane, "/pulse");
  const opened = await screenWhere(pane, "the overlay", (screen) =>
    screen.includes("Pulse · 2 open · quiet first"),
  );
  keep("pulse-10-you-row", opened);
  let last = -1;
  for (const text of [
    `c-${String(asked.id)}`,
    "Pick the vendor",
    "moved 5h ago",
    "1 step behind it, none started",
  ]) {
    const found = at(opened, text);
    assert.ok(found > last, `${text} is out of order:\n${opened}`);
    last = found;
  }
});

test("enter on a card shows its board link, and an empty board says so", async () => {
  const pane = await openMain();
  await screenWhere(pane, "the clear state", (screen) => screen.includes("board"));
  await herdr().submit(pane, "/pulse");
  const empty = await screenWhere(pane, "the overlay", (screen) =>
    screen.includes("Pulse · 0 open · quiet first"),
  );
  keep("pulse-4-empty", empty);
  assert.ok(empty.includes("Nothing is open."), empty);
  await herdr().press(pane, "escape");
  await screenWhere(pane, "the overlay to close", (screen) => !screen.includes("quiet first"));

  const idle = await card("Port the invoices");
  ageCard(cardd, idle, 5 * HOUR);
  await herdr().submit(pane, "/pulse");
  await screenWhere(pane, "the overlay", (screen) => screen.includes("Pulse · 1 open"));
  await herdr().press(pane, "enter");
  const link = `${cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/")}#/c-${String(idle.id)}`;
  const linked = await screenWhere(pane, "the board link", (screen) =>
    screen.replaceAll(/\s+/g, "").includes(link),
  );
  keep("pulse-5-link", linked);
  assert.ok(!linked.includes("quiet first"), "the overlay closed");
});

test("a card idle past 4 hours, which only main is told about, counts on main's pane and is named in /pulse", async () => {
  const idle = await card("Port the invoices");
  ageCard(cardd, idle, 5 * HOUR);
  const pane = await openMain();
  const counted = await screenWhere(pane, "the status bar to count the idle card", (screen) =>
    screen.includes("1 stalled card"),
  );
  keep("pulse-6-idle-count", counted);
  assert.ok(!counted.includes("✓ clear"), "an idle card is not clear");
  assert.ok(!counted.includes("Port the invoices"), "the status bar names no card");

  await herdr().submit(pane, "/pulse");
  const named = await screenWhere(pane, "the overlay to name the idle card", (screen) =>
    screen.includes("Pulse · 1 open"),
  );
  assert.ok(named.includes(`c-${String(idle.id)}`) && named.includes("IDLE 5h"), named);
});

test("a watcher with line breaks and escapes stays on its row and the overlay keeps its frame", async () => {
  const parked = await card("Crud ingress bypasses Cloud Armor");
  await cleo.call("hold", {
    card: parked.id,
    question: "Wait for the first hub use?",
    until: Date.now() + 10 * DAY,
    watcher: "the hub log\nsecond line\u001b[31m red",
    remaining: [],
  });
  ageCard(cardd, parked, 4 * DAY);
  const pane = await openMain();
  await screenWhere(pane, "the status bar to count the card", (screen) =>
    screen.includes("1 broken card"),
  );

  await herdr().submit(pane, "/pulse");
  const opened = await screenWhere(pane, "the overlay", (screen) =>
    screen.includes("Pulse · 1 open · quiet first"),
  );
  keep("pulse-7-multiline-watcher", opened);
  assert.ok(
    opened.includes("waits on the hub log second line red (fleet cannot check it)"),
    `the watcher is not one row:\n${opened}`,
  );

  const rows = opened.split("\n");
  const top = rows.findIndex((row) => row.includes("╭─ Pulse"));
  const bottom = rows.findIndex((row, at) => at > top && row.includes("╰"));
  const edge = Array.from(rows[top] ?? "");
  const [left, right] = [edge.indexOf("╭"), edge.indexOf("╮")];
  assert.ok(top >= 0 && bottom > top, `the overlay has no frame:\n${opened}`);
  for (const row of rows.slice(top + 1, bottom)) {
    const cells = Array.from(row);
    assert.ok(cells[left] === "│" && cells[right] === "│", `the frame breaks at: ${row}`);
  }
});

test("a long list of running cards scrolls inside the overlay, so every one can be reached and the frame stays", async () => {
  const titles = Array.from(
    { length: 40 },
    (_, at) => `Worker card ${String(at + 1).padStart(2, "0")}`,
  );
  for (const title of titles) await running(title);
  const pane = await openMain();
  await screenWhere(pane, "the pane to load the board", (screen) => screen.includes("board"));
  await herdr().submit(pane, "/pulse");
  await screenWhere(pane, "the overlay", (screen) =>
    screen.includes("Pulse · 40 open · quiet first"),
  );
  await herdr().press(pane, "enter");
  const seen = new Set<string>();
  const note = (screen: string): string => {
    for (const title of titles) if (screen.includes(title)) seen.add(title);
    return screen;
  };
  const top = await screenWhere(pane, "the list to open", (screen) =>
    screen.includes("⏎ collapse"),
  );
  keep("pulse-8-running-top", note(top));

  let pressed = 0;
  while (pressed < titles.length) {
    await herdr().press(pane, "down");
    note(await herdr().screen(pane));
    pressed += 1;
  }
  const end = await screenWhere(pane, "every running card to come into view", (screen) => {
    note(screen);
    return seen.size === titles.length;
  });
  keep("pulse-9-running-bottom", end);
  assert.deepEqual([...seen].sort(), titles);
  assert.ok(end.includes("esc close") && end.includes("╰"), `the frame is cut:\n${end}`);
});

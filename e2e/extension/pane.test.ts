import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { ageCard, ageSession } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const EVIDENCE = process.env["PANE_EVIDENCE_DIR"];
const EVENTS_ONLY = { FLEET_PANE_POLL_MS: "3600000" };
const QUICK_LIMITS = { FLEET_PANE_POLL_MS: "400", FLEET_PANE_SILENT_MS: "1500" };
const MINUTE = 60_000;
const PANE_TEXTS = ["●", "◇", "▲", "✓ clear"];
const DECISIONS_ITEM = /\d+ decisions? awaits? you/;
const awaiting = (count: number): string =>
  count === 1 ? "1 decision awaits you" : `${String(count)} decisions await you`;

let cardd: Cardd;
let h: Harness;
let opened: HerdrLab | undefined;
let scratch: Scratch;
let cleo: Session;
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
  const stopped = await Promise.allSettled([cleo.close(), opened?.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

function herdr(): HerdrLab {
  if (opened === undefined) throw new Error("the herdr lab is not open");
  return opened;
}

async function openMain(settings: Record<string, string>): Promise<string> {
  opened = await HerdrLab.start({
    ...h.piEnv("mate"),
    ...settings,
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
  });
  return startMain(opened, scratch, h);
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

const showing =
  (shown: readonly string[], hidden: readonly string[] = []) =>
  (screen: string): boolean =>
    shown.every((text) => screen.includes(text)) && !hidden.some((text) => screen.includes(text));

async function reload(pane: string, nth: number): Promise<void> {
  await herdr().submit(pane, "/probe-reload");
  await h.waitForNth((e) => e["type"] === "session" && e["reason"] === "reload", nth, "a reload");
}

async function cleoCard(title: string): Promise<Card> {
  return check(CardSchema, await cleo.call("card.new", { title, kind: "scout" }));
}

async function cleoAsksMain(card: Card): Promise<void> {
  await cleo.call("hold", { card: card.id, question: `${card.title}?`, options: ["Yes"] });
}

async function workerOf(card: Card): Promise<Session> {
  const attempt = await cleo.call("attempt.begin", {
    card: card.id,
    host: "maverick",
    task: "the task",
  });
  return cardd.connect(check(OPS["attempt.begin"].result, attempt).token);
}

async function cleoLandedCard(title: string): Promise<Card> {
  const card = await cleoCard(title);
  const next = { drop: "nothing to build" };
  await cleo.call("close.begin", { card: card.id, landed: true, next });
  await cleo.call("close.finish", {
    card: card.id,
    mode: "done",
    text: "checked",
    next,
    archives: [],
    left: [],
  });
  return card;
}

async function cleoScoutOf(title: string): Promise<Card> {
  const made = await cleo.call("card.new", { title, kind: "scout", project: "web" });
  return check(CardSchema, made);
}

async function cleoShipCard(title: string): Promise<Card> {
  const made = await cleo.call("card.new", { title, kind: "ship", project: "web" });
  return check(CardSchema, made);
}

const ESCALATED = "I put the scrollbar fix to you.";
const NOTED = "Noted, shipping it.";
const QUESTION = "Anything new?";

test("the status bar is quiet when nothing waits, counts decisions, and is quiet again once he answers", async () => {
  const card = await cleoCard("Ship the scrollbar fix");
  h.onModel(
    () => ({
      tool: "hold",
      args: {
        card: card.id,
        question: "Ship the scrollbar fix?",
        options: ["Ship it", "Hold"],
        to: "captain",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: ESCALATED }), "mate");
  h.onModel(() => ({ text: NOTED }), "mate");
  const pane = await openMain(EVENTS_ONLY);

  const clear = await screenWhere(pane, "the clear state", showing(["board"], ["decision"]));
  keep("1-clear", clear);

  await cleoAsksMain(card);
  const held = await screenWhere(
    pane,
    "the decision on the status bar",
    showing([awaiting(1), ESCALATED]),
  );
  keep("2-captain-holds", held);
  assert.ok(!held.includes("✓ clear"));
  assert.ok(!held.includes("needs you"), "the strip is gone");
  assert.ok(!held.includes("◆ c-"), "the strip is gone");

  const board = await cardd.board();
  const open = board.holds.find((each) => each.card === card.id);
  assert.ok(open !== undefined, "the hold is open on the board");
  assert.equal(
    await cardd.act(card.id, { kind: "answer", hold: open.hold, choice: "Ship it" }),
    200,
  );
  const answered = await screenWhere(
    pane,
    "the decision to go",
    showing(["board", NOTED], ["decision"]),
  );
  keep("3-answered", answered);

  const context = (await h.waitForCall(2, "mate", WAIT_MS))
    .map((turn) => `${turn.role}: ${turn.text}`)
    .join("\n");
  for (const text of PANE_TEXTS)
    assert.ok(!context.includes(text), `the model's context holds ${text}`);
  assert.ok(!DECISIONS_ITEM.test(context), "the model's context holds the decisions item");
});

test("the words count broken and stalled work and colour each kind, and landed work counts until the captain writes", async () => {
  const pane = await openMain(QUICK_LIMITS);
  await screenWhere(pane, "the clear state", showing(["board"]));

  const failing = await cleoShipCard("Fix the Cleo rule");
  const failed = await workerOf(failing);
  await failed.call("report", { status: "failed", text: "the build is red" });
  const quiet = await cleoShipCard("Port the calendar");
  const silent = await workerOf(quiet);
  silent.send({ t: "activity", state: "running" });
  await silent.call("standing", {});
  ageSession(cardd, quiet, 6 * MINUTE);
  await cleoLandedCard("Check the ads budget");

  const busy = await screenWhere(
    pane,
    "a broken and a stalled count, and a landing",
    showing(["1 broken card", "1 stalled card", "1 landed card"], ["✓ clear", "worker failed"]),
  );
  keep("4-broken-stalled-landed", busy);
  const colored = await herdr().coloredScreen(pane);
  keep("4-broken-stalled-landed.ansi", colored);
  const chipRow = colored.split("\n").find((row) => row.includes("stalled")) ?? "";
  const colorOf = (chip: string): string =>
    chipRow.slice(0, chipRow.indexOf(chip)).split("\u001b[").at(-1) ?? "";
  assert.ok(colorOf("broken").startsWith("38;"), "the broken chip has a foreground color");
  assert.ok(colorOf("stalled").startsWith("38;"), "the stalled chip has a foreground color");
  assert.notEqual(colorOf("broken"), colorOf("stalled"));

  await reload(pane, 1);
  await screenWhere(
    pane,
    "the same counts after a reload",
    showing(["1 broken card", "1 stalled card", "1 landed card"]),
  );

  await herdr().submit(pane, QUESTION);
  const heard = await screenWhere(
    pane,
    "the landing count to reset",
    showing([QUESTION], ["1 landed card"]),
  );
  keep("5-after-his-message", heard);

  await reload(pane, 2);
  await screenWhere(
    pane,
    "the counts after a second reload",
    showing(["1 broken card", "1 stalled card", QUESTION], ["1 landed card"]),
  );
});

test("the pane says only that cardd is not answering while it is down, and the counts return once it answers", async () => {
  const asked = await cleoCard("Ship the scrollbar fix");
  h.onModel(
    () => ({
      tool: "hold",
      args: {
        card: asked.id,
        question: "Ship the scrollbar fix?",
        options: ["Ship it", "Hold"],
        to: "captain",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: ESCALATED }), "mate");
  const pane = await openMain(QUICK_LIMITS);
  await screenWhere(pane, "the clear state", showing(["board"]));
  const failing = await cleoShipCard("Fix the Cleo rule");
  await (await workerOf(failing)).call("report", { status: "failed", text: "the build is red" });
  await cleoAsksMain(asked);
  await screenWhere(
    pane,
    "the failed worker and the decision",
    showing(["1 broken card", awaiting(1)]),
  );

  await cardd.stop();
  const down = await screenWhere(
    pane,
    "only the broken cardd",
    showing(["● cardd: not answering"], ["1 broken card", "await", "✓ clear"]),
  );
  keep("6-cardd-down", down);

  await cardd.restart();
  const back = await screenWhere(
    pane,
    "the counts again",
    showing(["1 broken card", awaiting(1)], ["cardd:"]),
  );
  keep("7-cardd-back", back);
});

test("a card handed back long ago that then reports blocked is not stalled until the limit has passed since the report", async () => {
  const pane = await openMain(QUICK_LIMITS);
  await screenWhere(pane, "the clear state", showing(["board"]));

  const handed = await cleoScoutOf("Check the ads budget");
  const handedWorker = await workerOf(handed);
  await handedWorker.call("report", { status: "done", text: "checked" });
  ageCard(cardd, handed, 6 * MINUTE);
  const clock = await cleoScoutOf("Read the old invoices");
  const clockWorker = await workerOf(clock);
  await clockWorker.call("report", { status: "stopped", text: "out of time" });
  ageCard(cardd, clock, 6 * MINUTE);
  await screenWhere(
    pane,
    "the clock card to stall, which proves the done report is older than the limit",
    showing(["1 stalled card"]),
  );
  await clockWorker.call("report", { status: "working", text: "back at it" });
  await screenWhere(pane, "the clock card to resume", showing(["board"], ["1 stalled card"]));

  await handedWorker.call("report", { status: "blocked", text: "the run is waiting" });
  await cleoLandedCard("Check the invoices");
  const fresh = await screenWhere(pane, "the pane to read the stop", showing(["1 landed card"]));
  keep("8-blocked-after-done", fresh);
  assert.ok(
    !fresh.includes("1 stalled card"),
    `a card that reported just now is stalled:\n${fresh}`,
  );
  assert.ok(!fresh.includes("✓ clear"));

  ageCard(cardd, handed, 6 * MINUTE);
  const stalled = await screenWhere(pane, "the stall limit to pass", showing(["1 stalled card"]));
  keep("9-stalled-after-the-limit", stalled);
});

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const EVIDENCE = process.env["PANE_EVIDENCE_DIR"];
const EVENTS_ONLY = { FLEET_PANE_POLL_MS: "3600000" };
const QUICK_LIMITS = {
  FLEET_PANE_POLL_MS: "400",
  FLEET_PANE_STALL_MS: "2500",
  FLEET_PANE_LOST_MS: "2500",
  FLEET_PANE_SILENT_MS: "1500",
};
const STALL_MS = 5000;
const STRIP_ROW = /^[◆●◇] \D/;
const DRAWN_BORDER = /[─│┌┐└┘╭╮╰╯]/;
const PANE_GLYPHS = ["◆", "●", "◇", "▲", "✓ clear"];

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

const rowsOf = (screen: string): string[] => screen.split("\n").map((row) => row.trim());
const stripRows = (screen: string): string[] => rowsOf(screen).filter((row) => STRIP_ROW.test(row));
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
  await cleo.call("close.begin", { card: card.id, landed: true });
  await cleo.call("close.finish", {
    card: card.id,
    mode: "done",
    text: "checked",
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

test("the pane shows no strip when all is clear, a strip and a count while the captain holds a card, and neither once he answers", async () => {
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

  const clear = await screenWhere(pane, "the clear state", showing(["✓ clear"]));
  keep("1-clear", clear);
  assert.deepEqual(stripRows(clear), []);

  await cleoAsksMain(card);
  const held = await screenWhere(
    pane,
    "the strip and the count",
    showing([`c-${String(card.id)} Ship the scrollbar fix: needs you`, "◆ 1", ESCALATED]),
  );
  keep("2-captain-holds", held);
  const [row, ...rest] = stripRows(held);
  assert.equal(rest.length, 0);
  assert.ok(row?.startsWith("◆ c-"), `the strip row is ${String(row)}`);
  assert.ok(!DRAWN_BORDER.test(row ?? ""), "the strip draws no rule");
  assert.ok(!held.includes("✓ clear"));

  const board = await cardd.board();
  const open = board.holds.find((each) => each.card === card.id);
  assert.ok(open !== undefined, "the hold is open on the board");
  assert.equal(
    await cardd.act(card.id, { kind: "answer", hold: open.hold, choice: "Ship it" }),
    200,
  );
  const answered = await screenWhere(
    pane,
    "the strip to go",
    showing(["✓ clear", NOTED], ["needs you", "◆"]),
  );
  keep("3-answered", answered);
  assert.deepEqual(stripRows(answered), []);

  const context = (await h.waitForCall(2, "mate", WAIT_MS))
    .map((turn) => `${turn.role}: ${turn.text}`)
    .join("\n");
  for (const glyph of PANE_GLYPHS)
    assert.ok(!context.includes(glyph), `the model's context holds ${glyph}`);
});

test("the strip shows the worst need first with the rest counted, the chips colour each kind, and landed work counts until the captain writes", async () => {
  const pane = await openMain(QUICK_LIMITS);
  await screenWhere(pane, "the clear state", showing(["✓ clear"]));

  const failing = await cleoShipCard("Fix the Cleo\nrule\u001b[31m");
  const failed = await workerOf(failing);
  await failed.call("report", { status: "failed", text: "the build is red" });
  const quiet = await cleoShipCard("Port the calendar");
  const silent = await workerOf(quiet);
  silent.send({ t: "activity", state: "running" });
  await cleoLandedCard("Check the ads budget");

  const busy = await screenWhere(
    pane,
    "a broken need first, a stalled one counted, and a landing",
    showing([
      `● c-${String(failing.id)} Fix the Cleo rule: worker failed`,
      "+1 more",
      "● 1",
      "◇ 1",
      "▲ 1",
    ]),
  );
  keep("4-broken-stalled-landed", busy);
  assert.equal(stripRows(busy).length, 1);
  const colored = await herdr().coloredScreen(pane);
  keep("4-broken-stalled-landed.ansi", colored);
  const chipRow = colored.split("\n").find((row) => row.includes("◇ 1")) ?? "";
  const colorOf = (chip: string): string =>
    chipRow.slice(0, chipRow.indexOf(chip)).split("\u001b[").at(-1) ?? "";
  assert.ok(colorOf("● 1").startsWith("38;"), "the broken chip has a foreground color");
  assert.ok(colorOf("◇ 1").startsWith("38;"), "the stalled chip has a foreground color");
  assert.notEqual(colorOf("● 1"), colorOf("◇ 1"));

  await reload(pane, 1);
  const reloaded = await screenWhere(
    pane,
    "the same counts after a reload",
    showing(["● 1", "◇ 1", "▲ 1"]),
  );
  assert.equal(stripRows(reloaded).length, 1);

  await herdr().submit(pane, QUESTION);
  const heard = await screenWhere(pane, "the landing count to reset", showing([QUESTION], ["▲"]));
  keep("5-after-his-message", heard);
  assert.equal(stripRows(heard).length, 1);

  await reload(pane, 2);
  const again = await screenWhere(
    pane,
    "the counts after a second reload",
    showing(["● 1", "◇ 1", QUESTION], ["▲"]),
  );
  assert.equal(stripRows(again).length, 1);
});

test("a title too wide for the strip is cut to one row and the count of the others stays apart from it", async () => {
  const pane = await openMain(QUICK_LIMITS);
  await screenWhere(pane, "the clear state", showing(["✓ clear"]));

  const wide = await cleoShipCard(
    "長いタイトル of a card title that cannot fit one row ".repeat(6),
  );
  await (await workerOf(wide)).call("report", { status: "failed", text: "the build is red" });
  const other = await cleoShipCard("Port the calendar");
  await (await workerOf(other)).call("report", { status: "failed", text: "also red" });

  const cut = await screenWhere(pane, "two broken cards", showing(["● 2"]));
  keep("10-wide-title-cut", cut);
  const [row, ...rest] = stripRows(cut);
  assert.equal(rest.length, 0, `the strip is more than one row:\n${cut}`);
  assert.ok(
    row?.startsWith(`● c-${String(wide.id)} 長いタイトル`),
    `the strip row is ${String(row)}`,
  );
  assert.match(row ?? "", /\.\.\. \+1 more$/, "the cut title does not run into the count");

  const colored = await herdr().coloredScreen(pane);
  keep("10-wide-title-cut.ansi", colored);
  const painted = colored.split("\n").find((line) => line.includes("+1 more")) ?? "";
  const tintAt = (text: string): string => {
    const before = painted.slice(0, painted.indexOf(text));
    const run = before.slice(before.lastIndexOf("\u001b[0m"));
    const tint = run.split("\u001b[").find((code) => code.startsWith("48;"));
    return tint?.split("m")[0] ?? "none";
  };
  assert.notEqual(tintAt("c-"), "none", "the strip has a tint");
  assert.equal(tintAt("+1 more"), tintAt("c-"), "the tint stops where the title is cut");
});

test("the pane says only that cardd is not answering while it is down, and the counts return once it answers", async () => {
  const pane = await openMain(QUICK_LIMITS);
  await screenWhere(pane, "the clear state", showing(["✓ clear"]));
  const failing = await cleoShipCard("Fix the Cleo rule");
  await (await workerOf(failing)).call("report", { status: "failed", text: "the build is red" });
  const worker = `c-${String(failing.id)} Fix the Cleo rule: worker failed`;
  await screenWhere(pane, "the failed worker", showing([worker, "● 1"]));

  await cardd.stop();
  const down = await screenWhere(
    pane,
    "only the broken cardd",
    showing(["● cardd: not answering", "● 1"], [worker, "+1 more"]),
  );
  keep("6-cardd-down", down);
  assert.equal(stripRows(down).length, 1);

  await cardd.restart();
  const back = await screenWhere(pane, "the failed worker again", showing([worker], ["cardd:"]));
  keep("7-cardd-back", back);
  assert.equal(stripRows(back).length, 1);
});

test("a card handed back long ago that then stops is not stalled until the limit has passed since it stopped", async () => {
  const pane = await openMain({ ...QUICK_LIMITS, FLEET_PANE_STALL_MS: String(STALL_MS) });
  await screenWhere(pane, "the clear state", showing(["✓ clear"]));

  const handed = await cleoScoutOf("Check the ads budget");
  const handedWorker = await workerOf(handed);
  await handedWorker.call("report", { status: "done", text: "checked" });
  const clock = await cleoScoutOf("Read the old invoices");
  const clockWorker = await workerOf(clock);
  await clockWorker.call("report", { status: "stopped", text: "out of time" });
  await screenWhere(
    pane,
    "the clock card to stall, which proves the done report is older than the limit",
    showing([`c-${String(clock.id)} Read the old invoices: worker stopped`, "◇ 1"]),
  );
  await clockWorker.call("report", { status: "working", text: "back at it" });
  await screenWhere(pane, "the clock card to resume", showing(["✓ clear"], ["◇"]));

  const stoppedAt = Date.now();
  await handedWorker.call("report", { status: "stopped", text: "the run was aborted" });
  await cleoLandedCard("Check the invoices");
  const fresh = await screenWhere(pane, "the pane to read the stop", showing(["▲ 1"]));
  keep("8-stopped-after-done", fresh);
  assert.ok(!fresh.includes("◇"), `a card that stopped just now is stalled:\n${fresh}`);
  assert.ok(fresh.includes("✓ clear"));
  assert.deepEqual(stripRows(fresh), []);

  const worker = `c-${String(handed.id)} Check the ads budget: worker stopped`;
  const stalled = await screenWhere(pane, "the stall limit to pass", showing([worker, "◇ 1"]));
  keep("9-stalled-after-the-limit", stalled);
  assert.ok(Date.now() - stoppedAt >= STALL_MS, "it stalled before the limit passed");
  assert.equal(stripRows(stalled).length, 1);
});

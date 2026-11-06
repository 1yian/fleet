import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { gate, Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { NEWEST, OLDEST, PROMPT, TURN_WORDS, writeLongSession } from "../support/long-session.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 120_000;
const TURNS = 12_000;
const RESTART_TURNS = 300;
const SEED_TURNS = 240;
const LIVE_TURNS = 300;
const WINDOW = 500;
const SAMPLE_MS = 6000;
const LOOP_P99_LIMIT_MS = 50;
const LOOP_LAG = fileURLToPath(new URL("../support/loop-lag.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TRANSCRIPT_TOP = "\u001b[1;5H";
const TRANSCRIPT_END = "\u001b[1;5F";
const EVIDENCE = process.env["HISTORY_WINDOW_EVIDENCE_DIR"];
const NOTICE = /(\d+) earlier entries are not drawn in this pane/;

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let lag: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  lag = join(scratch.parent, "loop-lag");
  configureMain(scratch, cardd.url, cardd.addLane("main", undefined, scratch.root));
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    LOOP_LAG_FILE: lag,
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
  });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function screenWhere(pane: string, what: string, ready: (screen: string) => boolean) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const screen = await lab.screen(pane);
    if (ready(screen)) return screen;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}:\n${screen}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function settledRuns(count: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (h.events.filter((event) => event["type"] === "settled").length < count) {
    assert.ok(Date.now() < deadline, `timed out waiting for run ${String(count)} to settle`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const lagSamples = (): number[] =>
  existsSync(lag)
    ? readFileSync(lag, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map(Number)
    : [];

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

async function startOn(session: string): Promise<string> {
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  writeFileSync(
    join(h.dir, "agent", "settings.json"),
    JSON.stringify({ compaction: { enabled: false } }),
  );
  return startMain(lab, scratch, h, false, [...mateArgs(h), "--session", session, "-e", LOOP_LAG]);
}

async function topOfPane(pane: string, ready: (screen: string) => boolean): Promise<string> {
  await lab.run(["pane", "send-text", pane, TRANSCRIPT_TOP]);
  return screenWhere(pane, "the top of the pane", ready);
}

const hiddenIn = (screen: string): number => Number(NOTICE.exec(screen)?.[1]);

async function answerWhileSampling(pane: string, ask: string, answer: string): Promise<void> {
  const working = gate();
  h.onModel(async () => {
    await working.wait;
    return { text: answer };
  }, "mate");
  await lab.submit(pane, ask);
  await screenWhere(pane, "the mate to work", (screen) => screen.includes("Working"));
  const before = lagSamples().length;
  await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
  const worked = lagSamples().slice(before);
  assert.ok(worked.length >= 3, `only ${String(worked.length)} loop samples while the mate worked`);
  assert.ok(
    median(worked) < LOOP_P99_LIMIT_MS,
    `the mate's event loop was late by ${String(median(worked))} ms at p99 while it worked: ${worked.join(", ")}`,
  );
  working.open();
  await screenWhere(pane, "the answer", (screen) => screen.includes(answer));
}

function keep(name: string, screen: string): void {
  if (EVIDENCE === undefined) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, `${name}.txt`), screen);
}

test("a mate with a very long conversation draws only the recent entries, says so, and keeps its event loop free while it works", async () => {
  const session = join(scratch.parent, "long-session.jsonl");
  writeLongSession(session, scratch.root, TURNS);
  const pane = await startOn(session);
  await screenWhere(pane, "the newest entry", (screen) => screen.includes(NEWEST));

  await answerWhileSampling(pane, "Any news for me?", "Nothing needs you.");

  const top = await topOfPane(pane, (screen) => NOTICE.test(screen));
  keep("top-of-the-pane", top);
  const hidden = hiddenIn(top);
  assert.ok(hidden > TURNS, `the notice counted only ${String(hidden)} entries`);
  assert.equal(top.includes(OLDEST), false);
});

test("a mate that starts below the window and works past it is drawn back to the window once the run settles, and not while the captain reads the top", async () => {
  const session = join(scratch.parent, "short-session.jsonl");
  writeLongSession(session, scratch.root, SEED_TURNS);
  const seeded = 2 * SEED_TURNS + 2;
  assert.ok(seeded <= WINDOW, "the session must start below the window");
  const pane = await startOn(session);
  await screenWhere(pane, "the newest entry", (screen) => screen.includes(NEWEST));
  const whole = await topOfPane(pane, (screen) => screen.includes(PROMPT));
  assert.equal(NOTICE.test(whole), false, `a session below the window has a notice:\n${whole}`);

  const answered = "The board is quiet.";
  for (let turn = 0; turn < LIVE_TURNS; turn++)
    h.onModel(
      () => ({ tool: "schedule_list", args: {}, text: `Live turn ${String(turn)}.` }),
      "mate",
    );
  h.onModel(() => ({ text: answered }), "mate");
  await lab.submit(pane, "Work through the board.");
  await settledRuns(1);
  const read = await lab.screen(pane);
  assert.equal(NOTICE.test(read), false, `the pane was trimmed under the captain's eyes:\n${read}`);
  assert.ok(read.includes(OLDEST) && read.includes(PROMPT), `the top was redrawn:\n${read}`);

  await lab.run(["pane", "send-text", pane, TRANSCRIPT_END]);
  await screenWhere(pane, "the answer", (screen) => screen.includes(answered));
  h.onModel(() => ({ text: "Still quiet." }), "mate");
  await lab.submit(pane, "Anything else?");
  await screenWhere(pane, "the second answer", (screen) => screen.includes("Still quiet."));
  await settledRuns(2);

  const top = await topOfPane(pane, (screen) => NOTICE.test(screen));
  keep("live-trim-top", top);
  const leftOut = seeded + 2 * LIVE_TURNS + 4 - WINDOW;
  assert.ok(
    hiddenIn(top) >= leftOut,
    `the notice counted ${String(hiddenIn(top))} of at least ${String(leftOut)} entries`,
  );
  assert.equal(top.includes(OLDEST), false);
  assert.equal(top.includes(PROMPT), false);

  await lab.run(["pane", "send-text", pane, TRANSCRIPT_END]);
  await answerWhileSampling(pane, "Any news for me?", "Nothing needs you.");
});

test("a restarted mate counts every entry it leaves out, draws no result without its call, and brings an older prompt back with the up arrow", async () => {
  const session = join(scratch.parent, "restarted-session.jsonl");
  writeLongSession(session, scratch.root, RESTART_TURNS);
  const pane = await startOn(session);
  await screenWhere(pane, "the newest entry", (screen) => screen.includes(NEWEST));

  const top = await topOfPane(pane, (screen) => NOTICE.test(screen));
  keep("restarted-top", top);
  const first = Number(new RegExp(`${TURN_WORDS}(\\d+)\\.`).exec(top)?.[1]);
  assert.ok(first > 0, `no turn was drawn under the notice:\n${top}`);
  assert.equal(
    hiddenIn(top),
    1 + 2 * first,
    `the notice does not count every entry left out:\n${top}`,
  );
  assert.equal(top.includes(PROMPT), false);

  await lab.press(pane, "up");
  await screenWhere(pane, "the older prompt in the editor", (screen) => screen.includes(PROMPT));
});

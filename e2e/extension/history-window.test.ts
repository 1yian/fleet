import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { gate, Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { NEWEST, OLDEST, writeLongSession } from "../support/long-session.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 120_000;
const TURNS = 12_000;
const SAMPLE_MS = 6000;
const LOOP_P99_LIMIT_MS = 50;
const LOOP_LAG = fileURLToPath(new URL("../support/loop-lag.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TRANSCRIPT_TOP = "\u001b[1;5H";
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

const lagSamples = (): number[] =>
  existsSync(lag)
    ? readFileSync(lag, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map(Number)
    : [];

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

test("a mate with a very long conversation draws only the recent entries, says so, and keeps its event loop free while it works", async () => {
  const session = join(scratch.parent, "long-session.jsonl");
  writeLongSession(session, scratch.root, TURNS);
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  writeFileSync(
    join(h.dir, "agent", "settings.json"),
    JSON.stringify({ compaction: { enabled: false } }),
  );
  const working = gate();
  h.onModel(async () => {
    await working.wait;
    return { text: "Nothing needs you." };
  }, "mate");
  const pane = await startMain(lab, scratch, h, false, [
    ...mateArgs(h),
    "--session",
    session,
    "-e",
    LOOP_LAG,
  ]);
  await screenWhere(pane, "the newest entry", (screen) => screen.includes(NEWEST));

  await lab.submit(pane, "Any news for me?");
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
  await screenWhere(pane, "the answer", (screen) => screen.includes("Nothing needs you."));

  await lab.run(["pane", "send-text", pane, TRANSCRIPT_TOP]);
  const top = await screenWhere(pane, "the notice at the top", (screen) => NOTICE.test(screen));
  if (EVIDENCE !== undefined) {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, "top-of-the-pane.txt"), top);
  }
  const hidden = Number(NOTICE.exec(top)?.[1]);
  assert.ok(hidden > TURNS, `the notice counted only ${String(hidden)} entries`);
  assert.equal(top.includes(OLDEST), false);
});

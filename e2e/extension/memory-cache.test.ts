import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { WireCall } from "../support/anthropic-wire.ts";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { tempDir } from "../support/run-root.ts";
import { configureMain, Scratch, settingsArgs, startMain } from "../support/scratch.ts";

const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const SUPPORT = new URL("../support/", import.meta.url);
const FAKE_MODEL = fileURLToPath(new URL("fake-model.ts", SUPPORT));
const FAKE_ANTHROPIC = fileURLToPath(new URL("fake-anthropic.ts", SUPPORT));
const FIRST = "PINEAPPLE";
const SECOND = "KUMQUAT";
const LARGE = "LYCHEE";
const AFTER_LARGE = "DURIAN";

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let cleo: Session;
let mainToken: string;
let memoryHome: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch("fleet");
  mainToken = cardd.addLane("main", undefined, scratch.root);
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  memoryHome = tempDir("fleet-memory-");
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([cleo.close(), lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  rmSync(memoryHome, { recursive: true, force: true });
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

function wireArgs(): string[] {
  const args = settingsArgs(h);
  const at = args.indexOf(FAKE_MODEL);
  return [...args.slice(0, at - 1), ...args.slice(at + 1), "-e", FAKE_ANTHROPIC];
}

function installMemory(): void {
  const profile = join(memoryHome, "profiles", "main");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "AGENTS.md"), "# Main\n\nThe first mate's memory.\n");
  const model = { provider: "tier", model: "orchestrator", thinking: "off" };
  writeFileSync(
    join(profile, "config.json"),
    JSON.stringify({ compactor: model, subagent: model }),
  );
  const config = { enabled: true, memoryHome, profile: "main" };
  writeFileSync(join(scratch.root, "config", "optchat.json"), JSON.stringify(config));
}

const isSummary = (call: WireCall): boolean =>
  call.turns.some(
    (turn) => turn.role === "system" && turn.text.includes("You write the memory of OptChat"),
  );
const isMainTurn = (call: WireCall): boolean =>
  !call.warm &&
  !isSummary(call) &&
  call.turns.some((turn) => turn.role === "system" && turn.text.includes("You are the first mate"));
const mentions = (call: WireCall, word: string): boolean =>
  call.turns.some((turn) => turn.text.includes(word));

async function askMain(text: string, word: string): Promise<WireCall> {
  const settled = h.events.filter((event) => event["type"] === "settled").length;
  await cleo.call("comment", { lane: "cleo", text });
  await h.waitForNth((event) => event["type"] === "settled", settled + 1, `main's turn on ${word}`);
  const call = h.wire.filter(isMainTurn).find((each) => mentions(each, word));
  assert.ok(call !== undefined, `main's model never got ${word}`);
  return call;
}

test("a mate with memory keeps the cached prompt between turns while it is warm, and builds a fresh view when the earlier turns grow large", async () => {
  configureMain(scratch, cardd.url, mainToken);
  installMemory();
  for (let call = 0; call < 200; call += 1)
    h.onModel((turns) => {
      const summary = turns.some((turn) => turn.text.includes("You write the memory of OptChat"));
      return { text: summary ? "work: a fleet message about the parser" : "noted" };
    }, "mate");
  await startMain(lab, scratch, h, false, wireArgs());
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");

  const first = await askMain(`Validation continues: ${FIRST}.`, FIRST);
  const second = await askMain(`Still validating: ${SECOND}.`, SECOND);
  assert.deepEqual(
    second.turns.slice(0, first.turns.length),
    first.turns,
    "the second turn's request does not start with the first turn's request",
  );
  assert.ok(second.turns.length > first.turns.length + 1);

  await askMain(`Full log: ${LARGE}. ${"The parser keeps every field. ".repeat(5_000)}`, LARGE);
  const fresh = await askMain(`After the log: ${AFTER_LARGE}.`, AFTER_LARGE);
  assert.notDeepEqual(
    fresh.turns.slice(0, first.turns.length),
    first.turns,
    "a turn after large earlier turns still sends the old view",
  );
  assert.ok(
    !fresh.turns.some((turn) => turn.text.includes("The parser keeps every field. ".repeat(100))),
    "the fresh view still sends the large turn raw",
  );
});

import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Pi } from "../support/harness.ts";
import { tempDir } from "../support/run-root.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const T0 = Date.parse("2026-05-04T09:00:00Z");
const SECOND = 1000;
const BIG = "lorem ipsum dolor ".repeat(8000);
const COMPACTOR_DOWN =
  "pi-tiers: no usable model for tier 'default' (anthropic/claude-opus-5-5 on anthropic: cooling, openai/gpt-5 on openai: cooling)";

let fleet: Fleet;
let h: Harness;
let clockFile: string;
let cleo: Pi;
let turns = 0;

beforeEach(async () => {
  clockFile = join(tempDir("fleet-clock-"), "clock");
  setClock(T0);
  fleet = await startFleet();
  h = await Harness.start();
  turns = 0;
  for (let call = 0; call < 200; call += 1)
    h.onModel((seen) => {
      if (!seen.some((turn) => turn.text.includes("ONLY output the structured summary")))
        return { text: "ok" };
      return { fail: COMPACTOR_DOWN };
    }, "cleo");
  const token = fleet.cardd.addLane("cleo", "main");
  const env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "mate",
    FLEET_FAKE_AGENT: "cleo",
    FLEET_CLOCK_FILE: clockFile,
  };
  cleo = h.startPi("cleo", env, [EXTENSION]);
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

function setClock(ms: number): void {
  const next = `${clockFile}.next`;
  writeFileSync(next, new Date(ms).toISOString());
  renameSync(next, clockFile);
}

function cool(until: number): void {
  const dir = join(h.dir, "agent", "tiers", "cooldowns");
  mkdirSync(dir, { recursive: true });
  const entry = { untilMs: until, reason: "rate-limit" };
  writeFileSync(
    join(dir, "1.json"),
    JSON.stringify({ "account:anthropic": entry, "account:openai": entry }),
  );
}

const attempts = (): number =>
  h
    .callsOf("cleo")
    .filter((seen) => seen.some((turn) => turn.text.includes("ONLY output the structured summary")))
    .length;

async function turn(): Promise<void> {
  turns += 1;
  cleo.prompt(`${BIG}${String(turns)}`);
  await h.waitForNth((event) => event["type"] === "settled", turns, "the turn to settle");
}

async function attemptsAfterTurn(): Promise<number> {
  await turn();
  return attempts();
}

test("failed compactions retry with exponential spacing, pause while no model is usable, and resume once after the cooldown expiry", async () => {
  let seen = await attemptsAfterTurn();
  while (seen === 0) seen = await attemptsAfterTurn();
  const first = seen;
  assert.equal(await attemptsAfterTurn(), first, "a retry came with no wait");
  assert.equal(await attemptsAfterTurn(), first, "a retry came with no wait");

  setClock(T0 + 29 * SECOND);
  assert.equal(await attemptsAfterTurn(), first, "a retry came before the first backoff");
  setClock(T0 + 31 * SECOND);
  const second = await attemptsAfterTurn();
  assert.equal(second, first + 1, "no retry after the first backoff");
  assert.equal(await attemptsAfterTurn(), second);

  setClock(T0 + 31 * SECOND + 59 * SECOND);
  assert.equal(await attemptsAfterTurn(), second, "the second backoff was not doubled");
  setClock(T0 + 31 * SECOND + 61 * SECOND);
  assert.equal(await attemptsAfterTurn(), second + 1, "no retry after the doubled backoff");

  const expiry = T0 + 3600 * SECOND;
  cool(expiry);
  setClock(T0 + 31 * SECOND + 61 * SECOND + 121 * SECOND);
  const third = await attemptsAfterTurn();
  assert.equal(third, second + 2, "no retry after the third backoff");

  setClock(expiry - SECOND);
  assert.equal(await attemptsAfterTurn(), third, "a retry ran while every model was cooling");
  assert.equal(await attemptsAfterTurn(), third);
  setClock(expiry + SECOND);
  assert.equal(await attemptsAfterTurn(), third + 1, "no resume after the expiry");
  assert.equal(await attemptsAfterTurn(), third + 1, "more than one resume");

  const heard = fleet.main.entries.filter((push) => push.entry.body.includes("compaction failed"));
  assert.equal(heard.length, 1, "the parent heard the compaction incident more than once");
});

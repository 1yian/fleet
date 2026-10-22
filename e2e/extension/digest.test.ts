import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const WORDS = ["PINEAPPLE", "KUMQUAT", "LYCHEE"];
const QUESTION = "DURIAN";

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let cleo: Session;
let mainToken: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  mainToken = cardd.addLane("main", undefined, scratch.root);
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([cleo.close(), lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const mentions = (turns: readonly Turn[], word: string): boolean =>
  turns.some((turn) => turn.role !== "system" && turn.text.includes(word));

async function startWithDigest(minutes: number): Promise<void> {
  for (let call = 0; call < 20; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  configureMain(scratch, cardd.url, mainToken, { costs: { digestMinutes: minutes } });
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
}

test("routine updates to a mate come together in one digest turn, and a hold wakes it at once", async () => {
  await startWithDigest(0.05);

  for (const word of WORDS)
    await cleo.call("comment", { lane: "cleo", text: `Progress: ${word}.` });
  const digest = await h.waitForCall(0, "mate");
  for (const word of WORDS) assert.ok(mentions(digest, word), `the digest turn lacks ${word}`);
  assert.ok(mentions(digest, "[fleet] digest: 3 routine updates"), "the turn has no digest line");
  await h.waitFor((event) => event["type"] === "settled", "the digest turn to end");
  assert.equal(h.callsOf("mate").length, 1, "a routine update started a turn of its own");

  const card: unknown = await cleo.call("card.new", { title: "Ship the parser", kind: "scout" });
  await cleo.call("hold", {
    card: Number(Reflect.get(Object(card), "id")),
    question: `Ship the parser? ${QUESTION}`,
    options: ["Yes"],
  });
  const asked = await h.waitForCall(1, "mate");
  assert.ok(mentions(asked, QUESTION));
  assert.ok(!mentions(asked.slice(-1), "[fleet] digest:"), "the question waited for a digest");
});

test("with costs.digestMinutes at 0, every routine update starts its own turn, as before", async () => {
  await startWithDigest(0);

  for (const [index, word] of WORDS.entries()) {
    await cleo.call("comment", { lane: "cleo", text: `Progress: ${word}.` });
    const turn = await h.waitForCall(index, "mate");
    assert.ok(mentions(turn, word));
  }
  assert.ok(!h.callsOf("mate").some((turns) => mentions(turns, "[fleet] digest:")));
});

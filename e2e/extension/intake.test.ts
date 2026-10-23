import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { lastUser } from "../support/dispatch-lab.ts";
import { gate, Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const REPORT = "[fleet] c-1 lint-gate blocked: The lint gate is red on main (card now with-mate)";
const AGAIN = `${REPORT} (sent again: the turn that got it ended before it was taken in)`;

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let mainToken: string;
let hung = gate();
beforeEach(async () => {
  hung = gate();
  cardd = await Cardd.start({ CARDD_TIMING_SCALE: "0.01" });
  cardd.addProject("web", { maverick: "/clones/web" });
  h = await Harness.start();
  scratch = new Scratch();
  mainToken = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, mainToken);
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  hung.open();
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function asMain(op: string, args: unknown): Promise<unknown> {
  const { status, body } = await cardd.post(mainToken, op, args);
  assert.equal(status, 200, JSON.stringify(body));
  return Reflect.get(Object(body), "value");
}

async function workerOn(): Promise<{ card: Card; worker: Session }> {
  const card = check(
    CardSchema,
    await asMain("card.new", {
      title: "Lint gate",
      name: "lint-gate",
      kind: "ship",
      project: "web",
    }),
  );
  const begun = await asMain("attempt.begin", { card: card.id, host: "maverick", task: "fix it" });
  const worker = await cardd.connect(check(OPS["attempt.begin"].result, begun).token);
  await worker.waitForEntries(1);
  return { card, worker };
}

const hangs = async (): Promise<{ text: string }> => {
  await hung.wait;
  return { text: "too late" };
};

async function abortTurn(pane: string, call: number): Promise<void> {
  await h.waitForCall(call, "mate", WAIT_MS);
  await lab.press(pane, "esc");
  await h.waitForNth(
    (event) => event["type"] === "settled" && event["aborted"] === true,
    call + 1,
    `aborted turn ${String(call + 1)}`,
  );
}

test("a report whose turn the captain aborts reaches main again, and main handles it", async () => {
  h.onModel(hangs, "mate");
  h.onModel(() => ({ text: "The lint gate is red; I will look at it" }), "mate");
  const pane = await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  const { worker } = await workerOn();

  await worker.call("report", { status: "blocked", text: "The lint gate is red on main" });
  assert.equal(lastUser(await h.waitForCall(0, "mate", WAIT_MS)), REPORT);
  await abortTurn(pane, 0);

  assert.equal(lastUser(await h.waitForCall(1, "mate", WAIT_MS)), AGAIN);
  await h.waitFor(
    (event) => event["type"] === "settled" && event["aborted"] === false,
    "main to finish the turn that took the report in",
  );
  await worker.close();
});

test("a report main has not taken in is resent again after each aborted turn", async () => {
  h.onModel(hangs, "mate");
  h.onModel(hangs, "mate");
  h.onModel(() => ({ text: "I have read it now" }), "mate");
  const pane = await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  const { worker } = await workerOn();

  await worker.call("report", { status: "blocked", text: "The lint gate is red on main" });
  assert.equal(lastUser(await h.waitForCall(0, "mate", WAIT_MS)), REPORT);
  await abortTurn(pane, 0);
  assert.equal(lastUser(await h.waitForCall(1, "mate", WAIT_MS)), AGAIN);
  await abortTurn(pane, 1);

  assert.equal(lastUser(await h.waitForCall(2, "mate", WAIT_MS)), AGAIN);
  await h.waitFor(
    (event) => event["type"] === "settled" && event["aborted"] === false,
    "main to take in the third delivery",
  );
  assert.equal(h.callsOf("mate").length, 3);
  await worker.close();
});

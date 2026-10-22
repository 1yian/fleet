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

test("a report main never takes in is sent once more, then shown on the board", async () => {
  h.onModel(hangs, "mate");
  h.onModel(hangs, "mate");
  const pane = await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  const { card, worker } = await workerOn();

  await worker.call("report", { status: "blocked", text: "The lint gate is red on main" });
  assert.equal(lastUser(await h.waitForCall(0, "mate", WAIT_MS)), REPORT);
  await abortTurn(pane, 0);
  assert.equal(lastUser(await h.waitForCall(1, "mate", WAIT_MS)), AGAIN);
  await abortTurn(pane, 1);

  const missed = await until(async () => {
    const { entries } = await cardd.thread(card.id);
    return entries.find((entry) => entry.author === "check" && entry.kind === "note");
  });
  assert.equal(
    missed.body,
    "missed: main did not take in this report from the worker, sent twice: The lint gate is red on main",
  );
  assert.equal(
    (await cardd.board()).cards.find((each) => each.id === card.id)?.summary,
    missed.body,
  );
  assert.equal(h.callsOf("mate").length, 2);
  await worker.close();
});

test("a report whose turns end because no model could answer keeps reaching main after a wait, and is never shown as missed", async () => {
  let failures = 0;
  for (let call = 0; call < 10; call += 1)
    h.onModel((turns) => {
      const last = lastUser(turns);
      if ((last === REPORT || last === AGAIN) && failures < 2) {
        failures += 1;
        return {
          fail: "pi-tiers: no usable model for tier 'orchestrator' (fake/scripted: cooling)",
        };
      }
      return { text: "The lint gate is red; I will look at it" };
    }, "mate");
  await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to join the fleet");
  const { card, worker } = await workerOn();

  await worker.call("report", { status: "blocked", text: "The lint gate is red on main" });
  await h.waitForNth(
    (event) => event["type"] === "settled" && event["aborted"] === false,
    3,
    "main to take the report in on the third turn",
  );
  const last = h.callsOf("mate").at(-1) ?? [];
  assert.equal(
    last.filter((turn) => turn.role !== "system" && turn.text.includes(AGAIN)).length,
    2,
    "the report did not reach main again after each failed turn",
  );

  const { entries } = await cardd.thread(card.id);
  assert.deepEqual(
    entries
      .filter((entry) => entry.author === "check" && entry.body.startsWith("missed"))
      .map((entry) => entry.body),
    [],
  );
  assert.equal(failures, 2);
  await worker.close();
});

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the board");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

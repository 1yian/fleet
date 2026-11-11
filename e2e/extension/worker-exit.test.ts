import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { gate, Harness, type Pi } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
  card = await newCard(fleet.main, "Assess the scrollbar", "scout");
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

async function worker(): Promise<Pi> {
  const token = await begin(fleet.main, card, "assess the scrollbar");
  const env = { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" };
  return h.startPi(`c-${String(card.id)}-a1`, env, [EXTENSION]);
}

async function reports(mate: Session): Promise<[unknown, string][]> {
  await mate.call("board", {});
  return mate.entries
    .map(({ entry }: { entry: Entry }) => entry)
    .filter((entry) => entry.kind === "report")
    .map((entry) => [entry.fields["status"], entry.body]);
}

test("a worker whose process ends in its last turn after done leaves the card done and closable", async () => {
  const held = gate();
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "Assessment delivered" } }));
  h.onModel(async () => {
    await held.wait;
    return { text: "Summary of the assessment" };
  });
  const pi = await worker();
  await h.waitForCall(1);
  await pi.end("SIGTERM");
  held.open();

  assert.deepEqual(await reports(fleet.main), [["done", "Assessment delivered"]]);
  assert.equal(await status(fleet.main, card), "with-mate");
  const plan = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: card.id, next: { drop: "nothing to build" } }),
  );
  assert.equal(plan.mode, "done");
});

test("a pane stop in the last turn after done leaves the card done and closable", async () => {
  const held = gate();
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "Assessment delivered" } }));
  h.onModel(async () => {
    await held.wait;
    return { text: "Summary of the assessment" };
  });
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "Nothing to add" } }));
  const pi = await worker();
  await h.waitForCall(1);
  pi.abort();
  await h.waitFor((e) => e["type"] === "settled" && e["aborted"] === true, "the stopped run");
  held.open();
  pi.prompt("Anything to add?");
  await fleet.main.waitForEntries(2);

  assert.deepEqual(await reports(fleet.main), [
    ["done", "Assessment delivered"],
    ["done", "Nothing to add"],
  ]);
  assert.equal(await status(fleet.main, card), "with-mate");
  const plan = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: card.id, next: { drop: "nothing to build" } }),
  );
  assert.equal(plan.mode, "done");
});

test("a worker whose pane closes in the middle of its work does not file a pane stop", async () => {
  const held = gate();
  h.onModel(async () => {
    await held.wait;
    return { text: "too late" };
  });
  const pi = await worker();
  await h.waitForCall(0);
  await pi.end("SIGHUP");
  held.open();

  assert.deepEqual(await reports(fleet.main), []);
  assert.equal(await status(fleet.main, card), "working");
});

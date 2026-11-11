import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Card } from "@fleet/protocol";
import { deliveryStates, isTaken, waitForTakenIn } from "../support/delivery-states.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { gate, Harness, type Pi, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
let env: Record<string, string>;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.02" });
  h = await Harness.start();
  card = await newCard(fleet.main, "Users see one scrollbar");
  const token = await begin(fleet.main, card, "run the tests");
  env = { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" };
});
afterEach(async () => {
  await Promise.all([h.stop(), fleet.cardd.stop()]);
});

async function resentAfterRestart(): Promise<void> {
  await fleet.cardd.restart();
  await h.waitForNth((event) => event["type"] === "fleet_connected", 2, "the worker to reconnect");
}

const sentAgain = (turns: Turn[]): boolean =>
  turns.some(
    (turn) =>
      turn.role === "user" &&
      turn.text.includes("sent again: the turn that got it ended before it was taken in"),
  );

test("a message whose turn was aborted is resent after reconnect and taken in on the next settled run", async () => {
  const held = gate();
  h.onModel(async () => {
    await held.wait;
    return { text: "the aborted turn should not finish" };
  });
  h.onModel(() => ({ text: "took the assignment" }));
  const pi = h.startPi("c-1-a1", env, [EXTENSION]);
  await h.waitForCall(0, "default", 30_000);
  pi.abort();
  await h.waitFor(
    (event) => event["type"] === "settled" && event["aborted"] === true,
    "the aborted turn to settle",
  );
  await resentAfterRestart();
  const again = await h.waitForCall(1, "default", 30_000);
  assert.ok(sentAgain(again), JSON.stringify(again));
  await h.waitFor(
    (event) => event["type"] === "settled" && event["aborted"] !== true,
    "the next run to settle",
  );
  held.open();
  await waitForTakenIn(fleet.cardd.db);
});

test("a message whose run was aborted is not taken in by a later run of the same process, and is sent again and taken in by the run that follows", async () => {
  const held = gate();
  const resent = gate();
  h.onModel(async () => {
    await held.wait;
    return { text: "the aborted turn should not finish" };
  });
  h.onModel(() => ({ text: "carried on with the assignment" }));
  h.onModel(() => ({ text: "nothing to hand off yet" }));
  h.onModel(async () => {
    await resent.wait;
    return { text: "took the assignment" };
  });
  const pi = h.startPi("c-1-a1", env, [EXTENSION]);
  await h.waitForCall(0, "default", 30_000);
  pi.abort();
  await h.waitFor(
    (event) => event["type"] === "settled" && event["aborted"] === true,
    "the aborted run to settle",
  );
  held.open();
  pi.prompt("carry on");
  const resumed = await h.waitForCall(1, "default", 30_000);
  assert.ok(resumed.some((turn) => turn.role === "user" && turn.text.includes("run the tests")));
  const again = await h.waitForCall(3, "default", 30_000);
  assert.ok(sentAgain(again), JSON.stringify(again));
  assert.ok(
    !deliveryStates(fleet.cardd.db).some(isTaken),
    "the resumed run took in a message its aborted run held",
  );
  resent.open();
  await waitForTakenIn(fleet.cardd.db);
});

test("a message whose run was aborted after a tool-use response is not taken in until a later run settles", async () => {
  const held = gate();
  h.onModel(() => ({ tool: "report", args: { status: "note", text: "reading the assignment" } }));
  h.onModel(async () => {
    await held.wait;
    return { text: "the aborted turn should not finish" };
  });
  h.onModel(() => ({ text: "took the assignment" }));
  const pi = h.startPi("c-1-a1", env, [EXTENSION]);
  await h.waitForCall(1, "default", 30_000);
  pi.abort();
  await h.waitFor(
    (event) => event["type"] === "settled" && event["aborted"] === true,
    "the aborted run to settle",
  );
  const states = deliveryStates(fleet.cardd.db);
  assert.ok(
    states.length > 0 && !states.some(isTaken),
    `an aborted run took the message in: ${JSON.stringify(states)}`,
  );
  await resentAfterRestart();
  const again = await h.waitForCall(2, "default", 30_000);
  assert.ok(sentAgain(again), JSON.stringify(again));
  await h.waitFor(
    (event) => event["type"] === "settled" && event["aborted"] !== true,
    "the next run to settle",
  );
  held.open();
  await waitForTakenIn(fleet.cardd.db);
});

const TASK_ENTRY = 1;
const HALF_A_WINDOW = "lorem ipsum dolor ".repeat(16000);
const TASK_TEXT = "run the tests";

async function abortedAfterLongResponses(responses = 2): Promise<Pi> {
  const held = gate();
  for (let call = 0; call < responses; call += 1)
    h.onModel(() => ({
      tool: "report",
      text: HALF_A_WINDOW,
      args: { status: "note", text: "reading the assignment" },
    }));
  h.onModel(async () => {
    await held.wait;
    return { text: "the aborted turn should not finish" };
  });
  const pi = h.startPi("c-1-a1", env, [EXTENSION]);
  await h.waitForCall(responses, "default", 30_000);
  pi.abort();
  await h.waitFor(
    (event) => event["type"] === "settled" && event["aborted"] === true,
    "the aborted run to settle",
  );
  held.open();
  assert.ok(!deliveryStates(fleet.cardd.db).some(isTaken), "an aborted run took the assignment in");
  return pi;
}

async function restartAndAsk(): Promise<void> {
  const restarted = h.startPi("c-1-a1", env, [EXTENSION]);
  await h.waitForNth((event) => event["type"] === "fleet_connected", 2, "the worker to reconnect");
  restarted.prompt("an unrelated question");
  await h.waitForNth((event) => event["type"] === "settled", 2, "the restarted run to settle");
}

const SUMMARY_MARKER = "ONLY output the structured summary";
const OVERFLOW = "prompt is too long: 300000 tokens > 200000 maximum";

async function assertResentAndTakenIn(): Promise<void> {
  const asked = h.calls.findLast(
    (turns) =>
      turns.some((turn) => turn.text === "an unrelated question") &&
      !turns.some((turn) => turn.text.includes(SUMMARY_MARKER)),
  );
  assert.ok(asked !== undefined, "the restarted model was never asked");
  assert.ok(
    !asked.some((turn) => turn.text.includes(TASK_TEXT)),
    "the restarted model held the assignment, so compaction did not remove it",
  );
  await h.waitForNth(
    (event) => event["type"] === "message_end" && event["entryId"] === TASK_ENTRY,
    2,
    "the assignment the restarted model never held to be sent again",
  );
  await h.waitForNth((event) => event["type"] === "settled", 3, "the resent assignment to settle");
  await waitForTakenIn(fleet.cardd.db);
}

test("a message that compaction removed before a restart is resent, not taken in by the restarted run", async () => {
  const pi = await abortedAfterLongResponses();
  pi.compact();
  assert.equal((await pi.compactResponse())["success"], true);
  await pi.kill();

  await restartAndAsk();
  await assertResentAndTakenIn();
});

test("a message that compaction removed between a restart and its first request is resent, not taken in by that run", async () => {
  const pi = await abortedAfterLongResponses();
  await pi.kill();

  await restartAndAsk();
  await h.waitFor((event) => event["type"] === "compacted", "the restarted run to compact first");
  await assertResentAndTakenIn();
});

test("a message that compaction removed while a failed request was retried is resent, not taken in by the retry's run", async () => {
  const pi = await abortedAfterLongResponses(1);
  await pi.kill();
  h.onModel(() => ({ fail: OVERFLOW }));

  await restartAndAsk();
  await h.waitFor((event) => event["type"] === "compacted", "the failed request to be compacted");
  await assertResentAndTakenIn();
});

test("a worker that read a comment hands off in the same run, before the run settles", async () => {
  h.onModel(async () => {
    await fleet.main.call("comment", { card: card.id, text: "scope change: skip the tests" });
    return { tool: "report", args: { status: "note", text: "running the tests" } };
  });
  h.onModel(() => ({
    tool: "report",
    args: { status: "blocked", text: "skipped the tests as asked" },
  }));
  h.onModel(() => ({ text: "handed off" }));
  h.startPi("c-1-a1", env, [EXTENSION]);

  const handoff = await fleet.main.waitForEntry(
    (entry) => entry.kind === "report" && entry.fields["status"] === "blocked",
    "main to hear the handoff the worker made after reading the comment",
  );
  assert.equal(handoff.body, "skipped the tests as asked");
  const turns = (await h.waitForCall(2, "default", 30_000)).map((turn) => turn.text).join("\n");
  assert.doesNotMatch(turns, /does not count yet/);
});

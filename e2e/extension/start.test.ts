// How dispatch knows that a worker started (spec section 11.2). herdr's own
// readiness check waits until the agent is idle, but a worker starts on its
// task at once. Dispatch therefore looks at the worker's pane, so the mate is
// not held while the worker works.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  lastUser,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { gate } from "../support/harness.ts";

/**
 * Dispatch returns once Pi shows in the pane, in about a second or two. herdr's own readiness wait
 * runs to its end, a little over 4 s, on a worker that is busy at once, so dispatch must not hold on it.
 */
const DISPATCH_WAIT_MS = 3500;

let parts: DispatchLab;
beforeEach(async () => {
  parts = await startDispatchLab();
});
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

test("dispatch returns while the worker is still busy with its first turn", async () => {
  const { h, lab, mate } = parts;
  const card = {
    title: "Users see one scrollbar",
    name: "one-scrollbar",
    kind: "ship",
    project: "site",
  };
  h.onModel(() => ({ tool: "card_new", args: card }), "mate");
  let asked = 0;
  let returned = 0;
  h.onModel(() => {
    asked = Date.now();
    return { tool: "dispatch", args: { card: 1, host: "local", task: "fix it" } };
  }, "mate");
  h.onModel(() => {
    returned = Date.now();
    return { text: "dispatched" };
  }, "mate");
  // The worker's first model call does not answer until the test lets it, so the worker stays busy.
  const busy = gate();
  h.onModel(async () => {
    await busy.wait;
    return { tool: "report", args: { status: "done", text: "PR green" } };
  }, "worker");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  await h.waitForCall(0, "worker", WORKER_WAIT_MS);
  const turns = await h.waitForCall(2, "mate", WORKER_WAIT_MS);
  assert.equal(toolResults(turns).at(-1), "Dispatched c-1-a1 on local, branch c-1-a1.");
  assert.ok(
    returned - asked < DISPATCH_WAIT_MS,
    `dispatch held the mate for ${String(returned - asked)} ms`,
  );
  assert.deepEqual(await workersOf(lab), ["c-1-a1"]);

  busy.open();
  await h.waitForCall(3, "mate", WORKER_WAIT_MS);
});

test("a worker that starts but never connects goes back to its mate, and dispatch did not wait for it", async () => {
  await stopDispatchLab(parts);
  // The worker's Pi runs, but its cardd URL is a port where nothing listens. cardd's timers run fast.
  parts = await startDispatchLab({
    cardd: { CARDD_TIMING_SCALE: "0.01" },
    workerArgs: ["--fleet-url", "ws://127.0.0.1:1"],
  });
  const { h, mate } = parts;
  const card = {
    title: "Users see one scrollbar",
    name: "one-scrollbar",
    kind: "ship",
    project: "site",
  };
  h.onModel(() => ({ tool: "card_new", args: card }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: { card: 1, host: "local", task: "fix it" } }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ text: "noted" }), "mate");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  const turns = await h.waitForCall(2, "mate", WORKER_WAIT_MS);
  assert.equal(toolResults(turns).at(-1), "Dispatched c-1-a1 on local, branch c-1-a1.");
  const woken = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.match(lastUser(woken) ?? "", /worker never connected/);
});

// How dispatch knows that a worker started (spec section 11.2). herdr's own
// readiness check waits until the agent is idle, but a worker starts on its
// task at once. Dispatch therefore looks at the worker's pane, so the mate is
// not held while the worker works.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { gate } from "../support/harness.ts";

/** Well below herdr's old 90 s wait: dispatch returns in seconds. */
const DISPATCH_WAIT_MS = 30_000;

let parts: DispatchLab;
beforeEach(async () => {
  parts = await startDispatchLab();
});
afterEach(async () => {
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
  h.onModel(() => ({ tool: "dispatch", args: { card: 1, host: "local", task: "fix it" } }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  // The worker's first model call does not answer until the test lets it, so the worker stays busy.
  const busy = gate();
  h.onModel(async () => {
    await busy.wait;
    return { tool: "report", args: { status: "done", text: "PR green" } };
  }, "worker");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  await h.waitForCall(0, "worker", WORKER_WAIT_MS);
  const turns = await h.waitForCall(2, "mate", DISPATCH_WAIT_MS);
  assert.equal(toolResults(turns).at(-1), "Dispatched c-1-a1 on local, branch c-1-a1.");
  assert.deepEqual(await workersOf(lab), ["c-1-a1"]);

  busy.open();
  await h.waitForCall(3, "mate", WORKER_WAIT_MS);
});

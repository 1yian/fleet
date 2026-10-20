// How dispatch knows that a worker started (spec section 11.2). herdr's own
// readiness check waits until the agent is idle, but a worker starts on its
// task at once. Dispatch therefore looks at the worker's pane, so the mate is
// not held while the worker works.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import {
  herdrStartRunning,
  lastUser,
  launchArgsOf,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { gate } from "../support/harness.ts";

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
  h.onModel(() => ({ tool: "dispatch", args: { card: 1, host: "local", task: "fix it" } }), "mate");
  // herdr's start command waits for the worker to idle, up to its own timeout, and this worker stays
  // busy. So the mate must hear back while that command still runs. A clock on the whole dispatch would
  // also count the new shell's start and herdr's refusals, which load stretches.
  let herdrWaiting: boolean | undefined;
  h.onModel(() => {
    herdrWaiting = herdrStartRunning(lab, "c-1-a1");
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
  assert.equal(herdrWaiting, true, "dispatch held the mate until herdr's start command ended");
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

test("a worker whose token begins with a dash starts on its task", async () => {
  await stopDispatchLab(parts);
  // 1 token in 64 begins with "-", and this worker's does. Pi must read it as the token, not as an option.
  parts = await startDispatchLab({ dashTokens: ["worker:c-1-a1"] });
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
  const pr = "https://github.com/acme/web/pull/1";
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "PR green", pr } }), "worker");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  const first = await h.waitForCall(0, "worker", WORKER_WAIT_MS);
  assert.equal(lastUser(first), "[fleet] main on c-1: fix it");
  const woken = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.equal(
    lastUser(woken),
    "[fleet] c-1 done: PR green (re your comment: fix it) (card now needs-you)",
  );
  const launched = readFileSync(launchArgsOf(h), "utf8").split("\n");
  assert.match(launched.find((arg) => arg.startsWith("--fleet-token=")) ?? "", /^--fleet-token=-/);
});

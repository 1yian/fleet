import assert from "node:assert/strict";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workerGroupOf,
  workersOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { Scratch } from "../support/scratch.ts";

const OLD_PROCESS_MS = 4000;
const INSTALLED_AGO_S = 2;

let parts: DispatchLab;
let scratch: Scratch;
beforeEach(async () => {
  scratch = new Scratch();
  parts = await startDispatchLab({
    extension: join(scratch.root, "packages", "extension", "src", "index.ts"),
  });
});
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
  scratch.dispose();
});

const dispatchCall = () => ({
  tool: "dispatch",
  args: { card: 1, host: "local", task: "fix the scrollbar" },
});

test("same-host dispatch restarts a worker whose process predates the installed code, and leaves a healthy one alone", async () => {
  const { h, lab, mate } = parts;
  h.onModel(
    () => ({
      tool: "card_new",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "site",
      },
    }),
    "mate",
  );
  for (let call = 0; call < 3; call += 1) {
    h.onModel(dispatchCall, "mate");
    h.onModel(() => ({ text: "done" }), "mate");
  }
  h.onModel(() => ({ tool: "run_long", args: { label: "wait", command: "sleep 600" } }), "worker");
  h.onModel(() => ({ text: "waiting for the job" }), "worker");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");
  await h.waitForCall(1, "worker", WORKER_WAIT_MS);
  await h.waitForCall(2, "mate", 120_000);
  const before = await workerGroupOf(lab, "c-1-a1");
  assert.ok(before !== undefined);

  await new Promise((resolve) => setTimeout(resolve, OLD_PROCESS_MS));
  const installed = new Date(Date.now() - INSTALLED_AGO_S * 1000);
  utimesSync(
    join(scratch.root, "packages", "extension", "src", "dispatch.ts"),
    installed,
    installed,
  );
  mate.prompt("restart the worker on the new code");
  const restarted = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.equal(restarted.at(-1), "Restarted c-1-a1 on local on its own session, branch c-1-a1.");
  await h.waitForCall(2, "worker", WORKER_WAIT_MS);
  const after = await workerGroupOf(lab, "c-1-a1");
  assert.ok(after !== undefined && after !== before, "the stale process was not replaced");
  assert.deepEqual(await workersOf(lab), ["c-1-a1"]);

  mate.prompt("dispatch again");
  const refused = toolResults(await h.waitForCall(6, "mate", WORKER_WAIT_MS));
  assert.equal(refused.at(-1), "c-1 is already running as c-1-a1 on local.");
  assert.equal(await workerGroupOf(lab, "c-1-a1"), after);
});

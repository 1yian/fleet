import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
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
import { tempDir } from "../support/run-root.ts";

const SLOW = fileURLToPath(new URL("../support/slow-transport.ts", import.meta.url));
const CHECKOUT = fileURLToPath(new URL("../..", import.meta.url));

let parts: DispatchLab;
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

test("a restarted worker hears that it was restarted in its first turn, even when the restart is slow to return", async () => {
  const armed = join(tempDir("slow-restart-"), "armed");
  parts = await startDispatchLab({
    hosts: { slow: ["node", SLOW, armed] },
    roots: { slow: CHECKOUT },
  });
  const { h, mate, lab } = parts;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "site",
        intent: "Fix the scrollbar",
        host: "slow",
        task: "fix the scrollbar",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => {
    writeFileSync(armed, "armed\n");
    return { tool: "restart_card", args: { card: 1 } };
  }, "mate");
  h.onModel(() => ({ text: "restarted" }), "mate");
  h.onModel(() => ({ tool: "run_long", args: { label: "wait", command: "sleep 600" } }), "worker");
  h.onModel(() => ({ text: "waiting for the job" }), "worker");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");
  await h.waitForCall(1, "worker", WORKER_WAIT_MS);
  await h.waitForCall(2, "mate", WORKER_WAIT_MS);

  const group = await workerGroupOf(lab, "c-1-a1");
  assert.ok(group !== undefined && group > 0);
  process.kill(-group, "SIGKILL");
  const deadline = Date.now() + 30_000;
  while ((await workersOf(lab)).includes("c-1-a1")) {
    assert.ok(Date.now() < deadline, "the killed worker still runs");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  mate.prompt("the worker died; restart it", "followUp");

  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.match(results.at(-1) ?? "", /^Started c-1-a1 again on slow/);
  const resumed = await h.waitForCall(2, "worker", WORKER_WAIT_MS);
  assert.ok(
    resumed.some((turn) => turn.text.includes("Your session was restarted on the same card")),
    "the restarted worker's first turn did not carry the restart notice",
  );
});

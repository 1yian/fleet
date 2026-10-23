import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import {
  avoidSeenOf,
  mateConnected as connected,
  startDispatchLab,
  stopDispatchLab,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";

let parts: DispatchLab;
beforeEach(async () => {
  parts = await startDispatchLab();
});
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

const seen = (): string[] => {
  const file = avoidSeenOf(parts.h);
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
    : [];
};

async function seenCount(count: number): Promise<string[]> {
  const deadline = Date.now() + WORKER_WAIT_MS;
  while (seen().length < count) {
    assert.ok(Date.now() < deadline, `only ${String(seen().length)} worker starts were seen`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return seen();
}

test("a restart with avoid starts the worker's Pi with PI_TIERS_AVOID, and a plain restart clears it", async () => {
  const { h, mate } = parts;
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
        host: "local",
        task: "fix the scrollbar",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({ tool: "restart_card", args: { card: 1, key: "a", avoid: ["claude-max", "openai"] } }),
    "mate",
  );
  h.onModel(() => ({ text: "restarted avoiding" }), "mate");
  h.onModel(() => ({ tool: "restart_card", args: { card: 1, key: "b" } }), "mate");
  h.onModel(() => ({ text: "restarted plain" }), "mate");
  for (let turn = 0; turn < 3; turn += 1) {
    h.onModel(
      () => ({ tool: "run_long", args: { label: `wait${String(turn)}`, command: "sleep 600" } }),
      "worker",
    );
    h.onModel(() => ({ text: "waiting for the job" }), "worker");
  }
  await connected(h);
  mate.prompt("ship the scrollbar fix");
  assert.deepEqual(await seenCount(1), ["(unset)"]);

  await h.waitForCall(2, "mate", WORKER_WAIT_MS);
  mate.prompt("restart it, avoiding claude-max and openai");
  assert.deepEqual(await seenCount(2), ["(unset)", "claude-max,openai"]);

  await h.waitForCall(4, "mate", WORKER_WAIT_MS);
  mate.prompt("restart it again");
  assert.deepEqual(await seenCount(3), ["(unset)", "claude-max,openai", "(unset)"]);
});

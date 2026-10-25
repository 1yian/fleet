import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { Scratch } from "../support/scratch.ts";

let scratch: Scratch;
let parts: DispatchLab;
beforeEach(async () => {
  scratch = new Scratch();
  parts = await startDispatchLab({
    extension: join(scratch.root, "packages/extension/src/index.ts"),
  });
});
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
  scratch.dispose();
});

test("run_long accepts two hours but rejects anything longer and paused dates are capped at 24 hours", async () => {
  const { h, mate } = parts;
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Verify tool limits",
        name: "tool-limits",
        kind: "scout",
        project: "site",
        intent: "Verify tool limits",
        host: "local",
        task: "verify limits",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({
      tool: "run_long",
      args: { label: "too-long", command: "printf forbidden", timeout_minutes: 120.001 },
    }),
    "worker",
  );
  h.onModel(
    () => ({
      tool: "run_long",
      args: { label: "at-limit", command: "printf accepted", timeout_minutes: 120 },
    }),
    "worker",
  );
  h.onModel(
    () => ({
      tool: "report",
      args: {
        status: "paused",
        text: "over limit",
        until: new Date(Date.now() + 86_460_000).toISOString(),
      },
    }),
    "worker",
  );
  h.onModel(
    () => ({
      tool: "report",
      args: {
        status: "paused",
        text: "at limit",
        until: new Date(Date.now() + 86_400_000).toISOString(),
      },
    }),
    "worker",
  );
  h.onModel(() => ({ text: "waiting" }), "worker");
  await mateConnected(h);
  mate.prompt("verify the tool limits");
  const turns = await h.waitForCall(4, "worker", WORKER_WAIT_MS);
  const results = toolResults(turns);
  assert.match(results[0] ?? "", /120/);
  assert.match(results[1] ?? "", /^Started job 1 \(at-limit\)/);
  assert.match(results[2] ?? "", /paused until must be within 24 hours from now/);
  assert.match(results[3] ?? "", /^Reported paused/);
  const deadline = Date.now() + 5_000;
  let status = (await parts.cardd.board()).cards[0]?.status;
  while (status !== "paused" && Date.now() < deadline) {
    status = (await parts.cardd.board()).cards[0]?.status;
  }
  assert.equal(status, "paused");
});

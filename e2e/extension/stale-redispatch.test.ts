import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
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

let parts: DispatchLab;
let scratch: Scratch;
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

test("dispatch creates new work and ordinary restart replaces an already-running worker on the same card and conversation", async () => {
  const { h, lab, mate, clone } = parts;
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
  h.onModel(() => ({ tool: "restart_card", args: { card: 1, key: "restart-once" } }), "mate");
  h.onModel(() => ({ text: "restarted" }), "mate");
  h.onModel(() => ({ tool: "restart_card", args: { card: 1, key: "restart-once" } }), "mate");
  h.onModel(() => ({ text: "duplicate left alone" }), "mate");
  h.onModel(() => ({ tool: "run_long", args: { label: "wait", command: "sleep 600" } }), "worker");
  h.onModel(() => ({ text: "waiting for the job" }), "worker");
  h.onModel(
    () => ({
      tool: "report",
      args: {
        status: "paused",
        text: "continued existing work",
        until: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
    "worker",
  );
  h.onModel(() => ({ text: "waiting" }), "worker");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");
  const dispatched = toolResults(await h.waitForCall(1, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
  assert.equal(dispatched, "Dispatched c-1-a1 on local, branch c-1-a1.");
  await h.waitForCall(1, "worker", WORKER_WAIT_MS);
  const before = await workerGroupOf(lab, "c-1-a1");
  assert.ok(before !== undefined);
  const work = join(`${clone}.worktrees/c-1-a1`, "unfinished.txt");
  writeFileSync(work, "keep my work\n");
  mate.prompt("restart the existing worker even though its process is still running");
  const result = toolResults(await h.waitForCall(3, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
  assert.match(result, /^Started c-1-a1 again on local, on its own session and branch c-1-a1\./);
  const resumed = await h.waitForCall(2, "worker", WORKER_WAIT_MS);
  assert.ok(
    resumed.some((turn) => turn.text.includes("fix the scrollbar\n\nDelivery: no-mistakes")),
  );
  assert.equal(readFileSync(work, "utf8"), "keep my work\n");
  const after = await workerGroupOf(lab, "c-1-a1");
  assert.ok(after !== undefined && after !== before);
  assert.deepEqual(await workersOf(lab), ["c-1-a1"]);
  mate.prompt("retry the same restart request");
  await h.waitForCall(5, "mate", WORKER_WAIT_MS);
  assert.equal(await workerGroupOf(lab, "c-1-a1"), after);
  assert.equal((await parts.cardd.board()).cards.length, 1);
});

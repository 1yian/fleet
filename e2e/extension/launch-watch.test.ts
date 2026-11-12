import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import {
  lastUser,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  WORKER_WAIT_MS,
  workersOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { tempDir } from "../support/run-root.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PR = "https://github.com/acme/site/pull/1";
const TORN_TRANSPORT = fileURLToPath(new URL("../support/torn-transport.ts", import.meta.url));

let parts: DispatchLab | undefined;
afterEach(async (t) => {
  if (parts !== undefined) {
    await parts.lab.printIfFailed(t);
    await stopDispatchLab(parts);
  }
  parts = undefined;
});

test("a worker that is still starting is not reported gone when herdr reads its process half-formed, and the worker's own report is the next word the mate hears", async () => {
  const firstSight = join(tempDir("fleet-torn-"), "first-sight");
  parts = await startDispatchLab({
    hosts: { torn: ["node", TORN_TRANSPORT, firstSight] },
    roots: { torn: REPO },
  });
  const { h, lab, mate } = parts;
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
        host: "torn",
        task: "fix the scrollbar",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({ tool: "report", args: { status: "done", text: "PR green", pr: PR } }),
    "worker",
  );
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  const woken = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.equal(
    lastUser(woken),
    `[fleet] c-1 one-scrollbar done: PR green (PR ${PR}) (card now needs-you)`,
  );
  assert.equal(existsSync(`${firstSight}.torn`), true);
  assert.deepEqual(await workersOf(lab), ["c-1-a1"]);
});

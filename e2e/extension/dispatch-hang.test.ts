import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  worktreesOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";

const PROBE_TIMEOUT_MS = 5_000;
const HANG_WAIT_MS = 45_000;

let parts: DispatchLab;
beforeEach(async () => {
  parts = await startDispatchLab({ mate: { FLEET_PROBE_TIMEOUT_MS: String(PROBE_TIMEOUT_MS) } });
});
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

test("a host that hangs past the timeout counts as unreachable for a replaced attempt", async () => {
  parts.h.onModel(
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
  parts.h.onModel(
    () => ({ tool: "dispatch", args: { card: 1, host: "far", task: "fix the scrollbar" } }),
    "mate",
  );
  parts.h.onModel(() => {
    writeFileSync(join(parts.h.dir, "far-down"), "hang\n");
    return {
      tool: "dispatch",
      args: { card: 1, host: "local", task: "fix the scrollbar", replace: true },
    };
  }, "mate");
  parts.h.onModel(
    () => ({ tool: "close", args: { card: 1, summary: "the design changed", landed: false } }),
    "mate",
  );
  parts.h.onModel(() => ({ text: "dropped" }), "mate");
  await mateConnected(parts.h);
  parts.mate.prompt("ship the scrollbar fix");

  const results = toolResults(await parts.h.waitForCall(4, "mate", HANG_WAIT_MS));
  assert.match(
    results.at(-1) ?? "",
    /^c-1 is dropped\. Left in place: far c-1-a1 \(herdr worktree on far failed: killed by SIGTERM\)\.$/,
  );
  assert.deepEqual(worktreesOf(parts.clone), [
    "branch refs/heads/main",
    "branch refs/heads/c-1-a1",
  ]);
});

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { poll } from "../support/harness.ts";
import {
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";

const RESTART_NOTICE = "Your session was restarted on the same card and conversation.";

let parts: DispatchLab;
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

test("a restart whose process could not be started never counts toward the hourly cap, so the mate can try again", async () => {
  parts = await startDispatchLab();
  const { h, mate, cardd } = parts;
  const down = join(h.dir, "far-down");
  const restart = { tool: "restart_card", args: { card: 1 } };
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
        host: "far",
        task: "fix the scrollbar",
      },
    }),
    "mate",
  );
  h.onModel(() => {
    writeFileSync(down, "down\n");
    return restart;
  }, "mate");
  for (let failing = 0; failing < 3; failing += 1) h.onModel(() => restart, "mate");
  h.onModel(() => {
    rmSync(down);
    return restart;
  }, "mate");
  h.onModel(() => ({ text: "restarted" }), "mate");
  h.onModel(() => ({ text: "working" }), "worker");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  const results = toolResults(await h.waitForCall(7, "mate", WORKER_WAIT_MS));
  assert.match(results.at(-6) ?? "", /^Dispatched c-1-a1 on far/);
  for (const refused of results.slice(-5, -1)) {
    assert.match(refused, /Operation timed out/);
    assert.doesNotMatch(refused, /was restarted 3 times/);
  }
  assert.match(results.at(-1) ?? "", /^Started c-1-a1 again on far/);
  const carriesNotice = (turns: readonly { text: string }[]): boolean =>
    turns.some((turn) => turn.text.includes(RESTART_NOTICE));
  await poll(
    () => h.callsOf("worker").find(carriesNotice),
    "the restarted worker's turn with the restart notice",
    WORKER_WAIT_MS,
  );
  const thread = await cardd.thread(1);
  assert.equal(
    thread.entries.filter((entry) => entry.fields["restartFailed"] !== undefined).length,
    4,
  );
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS } from "@fleet/protocol";
import { begin, startFleet, status, type Fleet } from "../support/fleet.ts";
import { reach } from "../support/reach.ts";
import { git } from "../support/remote.ts";
import { tempDir } from "../support/run-root.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

test("finished reminders say to close empty local-only branches without landing, with yolo off or on", async () => {
  const { cardd, main } = fleet;
  const clone = tempDir("fleet-empty-reminder-");
  git(clone, "init", "-q", "-b", "main");
  git(clone, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "Initial");
  cardd.addProject("review", { local: clone }, "acme/review", "local-only");

  for (const [yolo, expected] of [
    [false, "with-mate"],
    [true, "merging"],
  ] as const) {
    cardd.yolo("review", yolo);
    const card = check(
      CardSchema,
      await main.call("card.new", {
        title: "Check whether the repository needs changes",
        kind: "ship",
        project: "review",
      }),
    );
    const worker = await cardd.connect(await begin(main, card, "Inspect the branch", "local"));
    const branch = `c-${String(card.id)}-a1`;
    git(clone, "worktree", "add", "-q", "-b", branch, `${clone}.worktrees/${branch}`, "main");
    await worker.call("report", { status: "done", text: "No changes were needed" });

    const reminder = await reach(main, card, "finished", 1);
    assert.equal(await status(main, card), expected);
    assert.match(
      reminder.body,
      /Nothing lands from its empty branch\. Close it now with close\(card, summary\); no landing approval is needed\.$/,
    );
    const close = check(
      OPS["close.begin"].result,
      await main.call("close.begin", { card: card.id }),
    );
    assert.equal(close.mode, "done");
    assert.equal(close.land, false);
    await main.call("close.finish", {
      card: card.id,
      mode: "done",
      text: "No changes needed",
      archives: [],
      left: [],
    });
    assert.equal(await status(main, card), "done");
  }
});

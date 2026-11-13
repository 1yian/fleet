import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LiveFleet, until } from "../support/live-fleet.ts";
import { HELPER_ERROR, HELPER_SECRET, reloadFault } from "../support/reload-fault.ts";

let fleet: LiveFleet;
let fault: ReturnType<typeof reloadFault>;
beforeEach(async () => {
  fault = reloadFault();
  fleet = await LiveFleet.start({ ...fault.env, FLEET_MAINTENANCE_WAIT_MS: "15000" });
});
afterEach(async (t) => {
  await fleet.lab.printIfFailed(t);
  await fleet.stop();
});

for (const skip of [false, true]) {
  test(
    skip
      ? "the update fails a worker whose replacement never says hello before the verification deadline"
      : "the update reports an idle worker's helper failure with its name and redacted error",
    async () => {
      const untilDate = new Date(Date.now() + 3_600_000).toISOString();
      for (let call = 0; call < 100; call += 1) {
        fleet.h.onModel((turns) => {
          const at = turns.findLastIndex((turn) => turn.role === "user");
          return turns.slice(at).some((turn) => turn.role === "toolResult")
            ? { text: "waiting" }
            : { tool: "report", args: { status: "paused", text: "waiting", until: untilDate } };
        }, "worker");
        fleet.h.onModel(() => ({ text: "noted" }), "mate");
      }
      await fleet.startMain();
      const worker = await fleet.startWorker("helper-failure", "p620", true);
      const before = await until(async () => {
        const card = await fleet.cardOf(worker.card);
        return card.activity?.state === "idle" ? card : undefined;
      }, "the worker to pause and idle");
      assert.equal(before.status, "paused");
      const pid = await fleet.piIn(worker.pane);
      const calls = fleet.h.callsOf("worker").length;
      fault.fail(worker.pane, skip);
      await fleet.lab.submit(fleet.mainPane, "/updatefleet");
      await until(() => (fault.fired() ? true : undefined), "the controlled helper failure");
      const report = await until(
        () => fleet.userTexts("mate").find((text) => text.startsWith("[fleet] update:")),
        "the update's failure report",
      );
      const line = report.split("\n").find((text) => text.includes(worker.session)) ?? "";
      assert.match(line, /reload failed/);
      assert.ok(line.includes(skip ? "no replacement hello" : HELPER_ERROR), line);
      assert.equal(report.includes(HELPER_SECRET), false);
      assert.equal(await fleet.piIn(worker.pane), undefined);
      const after = await fleet.cardOf(worker.card);
      assert.equal(after.status, before.status);
      assert.equal(after.until, before.until);
      assert.equal(fleet.h.callsOf("worker").length, calls);
      const file = join(process.env["FLEET_HOST_DIR"] ?? "", "logs", "reloads.jsonl");
      const log = await until(() => {
        const text = readFileSync(file, "utf8");
        const lines = text.split("\n").filter((line) => line.includes(worker.worktree));
        return lines.some((line) => line.includes('"event":"error"'))
          ? lines.join("\n")
          : undefined;
      }, "the persisted helper error");
      assert.ok(log.includes(`"pid":${String(pid)}`));
      assert.ok(log.includes('"event":"start"'));
      assert.ok(log.includes(skip ? "no replacement hello" : HELPER_ERROR));
      assert.equal(log.includes(HELPER_SECRET), false);
    },
  );
}

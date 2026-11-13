import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import type { Move } from "../support/harness.ts";
import { LiveFleet, lastUser, until, type Worker } from "../support/live-fleet.ts";
import { git } from "../support/remote.ts";
import { parseRecord } from "../support/json.ts";

let fleet: LiveFleet;
beforeEach(async () => {
  fleet = await LiveFleet.start({ FLEET_MAINTENANCE_WAIT_MS: "15000" });
});
afterEach(async (t) => {
  await fleet.lab.printIfFailed(t);
  await fleet.stop();
});

function script(until: string): void {
  for (let call = 0; call < 100; call += 1) {
    fleet.h.onModel((turns) => {
      const at = turns.findLastIndex((turn) => turn.role === "user");
      if (turns.slice(at).some((turn) => turn.role === "toolResult")) return { text: "waiting" };
      const held = turns.some((turn) => turn.role === "user" && turn.text.includes("START-held"));
      const move: Move = {
        tool: "report",
        args: held
          ? { status: "needs-decision", key: "wait", text: "waiting for a decision" }
          : { status: "paused", text: "waiting for CI", until },
      };
      return move;
    }, "worker");
    fleet.h.onModel(() => ({ text: "noted" }), "mate");
  }
}

async function view(worker: Worker) {
  return check(OPS.card.result, await fleet.ghost.call("card", { card: worker.card }));
}

async function reload(round: number, workers: readonly Worker[]): Promise<void> {
  const old = await Promise.all(workers.map((worker) => fleet.piIn(worker.pane)));
  const main = await fleet.matePid("main");
  await fleet.lab.submit(fleet.mainPane, "/updatefleet");
  const report = await until(
    () => {
      const reports = fleet.userTexts("mate").filter((text) => text.startsWith("[fleet] update:"));
      return reports[round - 1];
    },
    `update ${String(round)} to finish`,
  );
  for (const [index, worker] of workers.entries()) {
    assert.ok(report.includes(`${worker.session} (worker on p620): reload completed`), report);
    assert.notEqual(await fleet.newPid(worker.pane, old[index] ?? 0), old[index]);
    await until(
      async () => {
        const card = await fleet.cardOf(worker.card);
        return card.activity?.state === "idle" ? true : undefined;
      },
      `${worker.session} to reconnect after update ${String(round)}`,
    );
    const sessions = fleet.sessionEvents(realpathSync(worker.worktree));
    assert.equal(sessions.length, round + 1);
    assert.equal(new Set(sessions.map((event) => event["file"])).size, 1);
    assert.equal(git(worker.worktree, "branch", "--show-current"), worker.branch);
  }
  await fleet.newPid(fleet.mainPane, main);
  await until(
    () => fleet.sessionEvents(realpathSync(fleet.here.root))[round],
    `main to start after update ${String(round)}`,
  );
}

test("paused and held workers reconnect after consecutive updates including a no-change update, keep their waits, and hear the next comment", async () => {
  const untilDate = new Date(Date.now() + 3_600_000).toISOString();
  script(untilDate);
  await fleet.startMain();
  const paused = await fleet.startWorker("paused", "p620", true);
  const held = await fleet.startWorker("held", "p620", true);
  await until(async () => {
    const cards = await Promise.all([view(paused), view(held)]);
    return cards[0].card.status === "paused" &&
      cards[1].hold !== null &&
      cards.every((each) => each.card.activity?.state === "idle")
      ? true
      : undefined;
  }, "both workers to wait");
  const before = await Promise.all([view(paused), view(held)]);
  assert.deepEqual(
    before.map((each) => each.card.status),
    ["paused", "with-mate"],
  );
  assert.equal(before[1].hold?.question, "waiting for a decision");
  const calls = fleet.h.callsOf("worker").length;
  const fresh = fleet.landCode();
  for (const round of [1, 2]) {
    await reload(round, [paused, held]);
    assert.equal(git(fleet.p620.root, "rev-parse", "HEAD"), fresh);
    assert.equal(fleet.h.callsOf("worker").length, calls);
    for (const [index, worker] of [paused, held].entries()) {
      const now = await view(worker);
      assert.equal(now.card.status, before[index]?.card.status);
      assert.equal(now.card.until, before[index]?.card.until);
      assert.deepEqual(now.hold, before[index]?.hold);
    }
  }
  for (const worker of [paused, held]) {
    const connections = fleet.cardd.output
      .split("\n")
      .filter((line) => line.includes('{"at":'))
      .map((line) => parseRecord(line.slice(line.indexOf("{"))))
      .filter((row) => row["session"] === worker.session);
    const hellos = connections.filter((row) => row["event"] === "hello");
    assert.equal(hellos.length, 3);
    assert.equal(new Set(hellos.map((row) => row["pid"])).size, 3);
    for (const hello of hellos) {
      assert.equal(typeof hello["startedAt"], "number");
      assert.ok(Number(hello["startedAt"]) <= Date.now());
      assert.ok(
        connections.some(
          (row) =>
            row["event"] === "close" && row["pid"] === hellos[0]?.["pid"] && row["code"] === 1000,
        ),
      );
    }
    await until(() => {
      const file = join(process.env["FLEET_HOST_DIR"] ?? "", "logs", "reloads.jsonl");
      const rows = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map(parseRecord)
        .filter((row) => row["home"] === worker.worktree && row["event"] === "success");
      return rows.length === 2 ? rows : undefined;
    }, `${worker.session}'s persisted reload successes`);
    const comment = `AFTER-TWO-RELOADS ${worker.session}`;
    await fleet.ghost.call("comment", { card: worker.card, text: comment });
    await until(
      () => fleet.h.callsOf("worker").find((turns) => lastUser(turns).includes(comment)),
      `${worker.session} to hear its comment`,
    );
  }
});

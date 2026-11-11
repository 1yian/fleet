import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { gate } from "../support/harness.ts";
import { LiveFleet, lastUser, until } from "../support/live-fleet.ts";
import { BRANCH_SKEW, WELCOME_SKEW } from "../support/protocol-skew.ts";

let fleet: LiveFleet | undefined;
afterEach(async (t) => {
  await fleet?.lab.printIfFailed(t);
  await fleet?.stop();
  fleet = undefined;
});

const connected = (event: Record<string, unknown>): boolean => event["type"] === "fleet_connected";

test("a worker that cannot read a restarted cardd reloads itself on its own conversation, and a comment sent afterwards reaches it", async () => {
  fleet = await LiveFleet.start({}, { olderCode: WELCOME_SKEW });
  for (let call = 0; call < 10; call += 1) fleet.h.onModel(() => ({ text: "ok" }), "worker");
  const worker = await fleet.startWorker("quiet", "local");
  await fleet.h.waitForNth(connected, 1, "the worker to connect");
  const before = await until(() => fleet?.piIn(worker.pane), "the worker to run Pi");

  await fleet.restartOnNewerCode();

  assert.notEqual(await fleet.newPid(worker.pane, before), before);
  await fleet.h.waitForNth(connected, 2, "the reloaded worker to connect");
  await fleet.ghost.call("comment", { card: worker.card, text: "CHECK-AFTER-CARDD-RESTART" });
  await until(
    () =>
      fleet?.h
        .callsOf("worker")
        .find((turns) => lastUser(turns).includes("CHECK-AFTER-CARDD-RESTART")),
    "the worker to hear the comment",
  );
  const refusals = fleet.cardd.output
    .split("\n")
    .filter((line) => line.includes(`session ${worker.session} cannot read what cardd sends it`));
  assert.equal(refusals.length, 1);
  assert.match(refusals[0] ?? "", /must have required properties lowWater/);
});

test("a worker that cannot read an answer still reloads when its turn ends, although it reconnected meanwhile", async () => {
  fleet = await LiveFleet.start({}, { olderCode: BRANCH_SKEW });
  const held = gate();
  fleet.h.onModel(() => ({ tool: "branch", args: { name: "fix/quiet-scout" } }), "worker");
  fleet.h.onModel(async () => {
    await held.wait;
    return { text: "ok" };
  }, "worker");
  const worker = await fleet.startWorker("quiet", "local");
  await fleet.h.waitForNth(connected, 1, "the worker to connect");
  const before = await until(() => fleet?.piIn(worker.pane), "the worker to run Pi");
  const answered = await fleet.h.waitForCall(1, "worker");
  assert.match(
    answered.findLast((turn) => turn.role === "toolResult")?.text ?? "",
    /cardd's answer to branch\.name cannot be read by this session/,
  );

  await fleet.restartOnNewerCode();
  await fleet.h.waitForNth(connected, 2, "the worker to reconnect on the same process");
  assert.equal(await fleet.piIn(worker.pane), before);
  held.open();

  assert.notEqual(await fleet.newPid(worker.pane, before), before);
  await fleet.h.waitForNth(connected, 3, "the reloaded worker to connect");
});

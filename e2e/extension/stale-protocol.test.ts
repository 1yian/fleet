import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { LiveFleet, lastUser, until } from "../support/live-fleet.ts";

let fleet: LiveFleet | undefined;
afterEach(async (t) => {
  await fleet?.lab.printIfFailed(t);
  await fleet?.stop();
  fleet = undefined;
});

const connected = (event: Record<string, unknown>): boolean => event["type"] === "fleet_connected";

test("a worker that cannot read a restarted cardd reloads itself on its own conversation, and a comment sent afterwards reaches it", async () => {
  fleet = await LiveFleet.start({}, { olderWelcome: true });
  for (let call = 0; call < 10; call += 1) fleet.h.onModel(() => ({ text: "ok" }), "worker");
  const worker = await fleet.startWorker("quiet", "local");
  await fleet.h.waitForNth(connected, 1, "the worker to connect");
  const before = await until(() => fleet?.piIn(worker.pane), "the worker to run Pi");

  await fleet.restartOnNewerWelcome();

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

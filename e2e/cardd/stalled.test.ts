import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { ageSession, begin, MINUTE, newCard, startFleet, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_CHECK_EVERY_MS: "50" });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

test("a silent worker waiting on a live long job is not reported stalled, but is once the job ends", async () => {
  const card = await newCard(fleet.main, "live watch");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const { job } = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "watch", command: "watch events" }),
  );
  worker.send({ t: "activity", state: "running" });
  await worker.call("job.alive", { job });
  const control = await newCard(fleet.main, "unattended control");
  const silent = await fleet.cardd.connect(await begin(fleet.main, control));
  silent.send({ t: "activity", state: "running" });
  await silent.call("jobs", {});
  ageSession(fleet.cardd, card, 11 * MINUTE);
  ageSession(fleet.cardd, control, 11 * MINUTE);
  await fleet.main.waitForEntry(
    (entry) =>
      entry.card === control.id &&
      entry.fields["condition"] === "worker-stalled" &&
      Number(entry.fields["tier"]) >= 2,
    "the unattended worker's second stall reminder",
  );
  const view = check(OPS.card.result, await fleet.main.call("card", { card: card.id }));
  assert.deepEqual(
    view.entries.filter((entry) => entry.fields["condition"] === "worker-stalled"),
    [],
  );
  const board = check(OPS.board.result, await fleet.main.call("board", {}));
  assert.deepEqual(
    [card, control].map(({ id }) => board.find((each) => each.id === id)?.pulse?.state),
    ["running", "stalled"],
  );
  await worker.call("job.finish", { job, exitCode: 0, outputTail: "checkpoint reached" });
  const stalled = await fleet.main.waitForEntry(
    (entry) => entry.card === card.id && entry.fields["condition"] === "worker-stalled",
    "the formerly covered worker's stall reminder",
  );
  assert.equal(stalled.body, "worker stalled");
});

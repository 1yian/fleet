import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
let beats: NodeJS.Timeout[] = [];
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
});
afterEach(async () => {
  for (const beat of beats) clearInterval(beat);
  beats = [];
  const calls = fleet.cardd.gh.calls();
  await fleet.cardd.stop();
  assert.deepEqual(calls, [], "no wake, report, or close may invoke gh");
});

const reach = (session: Session, card: Card, condition: string, tier: number): Promise<Entry> =>
  session.waitForEntry(
    (entry) =>
      entry.card === card.id &&
      entry.fields["condition"] === condition &&
      Number(entry.fields["tier"]) >= tier,
    `${condition} tier ${String(tier)} on c-${String(card.id)}`,
  );

async function metronome(ticks: number): Promise<void> {
  const card = await newCard(fleet.main, "a clock for the test");
  await begin(fleet.main, card);
  await reach(fleet.main, card, "worker-never-connected", ticks);
}

test("a lost job is reminded to its mate each tier until the worker runs it again or drops it", async () => {
  const card = await newCard(fleet.main, "long jobs");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const start = async (label: string): Promise<number> =>
    check(OPS["job.start"].result, await worker.call("job.start", { label, command: "sleep 9" }))
      .job;
  const dropped = await start("tests");
  const rerun = await start("build");
  await reach(fleet.main, card, "job-lost-open", 2);
  const twice = fleet.main.entries.filter(
    ({ entry }) => entry.fields["condition"] === "job-lost-open",
  );
  assert.ok(twice.some(({ entry }) => entry.body.includes(`job ${String(dropped)} (tests)`)));
  assert.ok(twice.some(({ entry }) => entry.body.includes(`job ${String(rerun)} (build)`)));

  await worker.call("job.finish", { job: dropped, exitCode: 130, outputTail: "" });
  const again = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "build", command: "sleep 9" }),
  ).job;
  beats.push(
    setInterval(() => {
      worker.call("job.alive", { job: again }).catch(() => undefined);
    }, 20),
  );
  const counts = (): number =>
    fleet.main.entries.filter(({ entry }) => entry.fields["condition"] === "job-lost-open").length;
  const stopped = counts();
  await metronome(4);
  assert.equal(counts(), stopped);
});

test("a job that was marked lost while its process lives is running again on its next heartbeat", async () => {
  const card = await newCard(fleet.main, "silent but alive");
  const token = await begin(fleet.main, card);
  const worker = await fleet.cardd.connect(token);
  const { job } = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "poll", command: "lavish-axi poll" }),
  );
  await reach(fleet.main, card, "job-lost-open", 1);
  const listed = async (): Promise<number[]> =>
    check(OPS.jobs.result, await worker.call("jobs", {})).map((each) => each.id);
  assert.deepEqual(await listed(), []);

  const alive = check(OPS["job.alive"].result, await worker.call("job.alive", { job }));
  assert.equal(alive.running, true);
  assert.deepEqual(await listed(), [job]);
  const isRevival = (entry: Entry): boolean => entry.fields["revived"] === true;
  await worker.waitForEntry(isRevival, "the revival reaches the worker");
  beats.push(
    setInterval(() => {
      worker.call("job.alive", { job }).catch(() => undefined);
    }, 20),
  );
  const counts = (): number =>
    fleet.main.entries.filter(({ entry }) => entry.fields["condition"] === "job-lost-open").length;
  const before = counts();
  await metronome(4);
  assert.equal(counts(), before);
  const done = check(
    OPS["job.finish"].result,
    await worker.call("job.finish", { job, exitCode: 0, outputTail: "ok" }),
  );
  assert.equal(done.recorded, true);
});

test("a dropped lost job stays lost when its wrapper heartbeats again", async () => {
  const card = await newCard(fleet.main, "dropped then alive");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const { job } = check(
    OPS["job.start"].result,
    await worker.call("job.start", { label: "poll", command: "lavish-axi poll" }),
  );
  await reach(fleet.main, card, "job-lost-open", 1);
  await worker.call("job.drop", { job });
  const alive = check(OPS["job.alive"].result, await worker.call("job.alive", { job }));
  assert.equal(alive.running, false);
  assert.deepEqual(check(OPS.jobs.result, await worker.call("jobs", {})), []);
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { until } from "../support/live-fleet.ts";

let fleet: Fleet;
let beats: NodeJS.Timeout[] = [];
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.004" });
});
afterEach(async () => {
  for (const beat of beats) clearInterval(beat);
  beats = [];
  await fleet.cardd.stop();
});

const findings = async (card: Card, condition: string): Promise<Entry[]> =>
  check(CardViewSchema, await fleet.main.call("card", { card: card.id })).entries.filter(
    (entry) => entry.author === "check" && entry.fields["condition"] === condition,
  );

async function startJob(worker: Session, label: string): Promise<number> {
  const started = await worker.call("job.start", { label, command: "sleep 9" });
  return check(OPS["job.start"].result, started).job;
}

async function checksPass(): Promise<void> {
  const clock = await newCard(fleet.main, "a clock for the test");
  await begin(fleet.main, clock);
  await fleet.main.waitForEntry(
    (entry) =>
      entry.card === clock.id &&
      entry.fields["condition"] === "worker-never-connected" &&
      Number(entry.fields["tier"]) >= 3,
    "three checks of the clock card",
  );
}

const listed = async (worker: Session): Promise<Record<number, boolean>> =>
  Object.fromEntries(
    check(OPS.jobs.result, await worker.call("jobs", {})).map((each) => [each.id, each.silent]),
  );

const gone = async (worker: Session, job: number): Promise<boolean> =>
  check(OPS["job.gone"].result, await worker.call("job.gone", { job })).lost;

test("a silent job stays running however long it is silent, and is lost only when its own worker reports its process gone", async () => {
  const card = await newCard(fleet.main, "silent but not gone");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const other = await newCard(fleet.main, "someone else's card");
  const stranger = await fleet.cardd.connect(await begin(fleet.main, other));
  const job = await startJob(worker, "silent");
  await until(async () => ((await listed(worker))[job] ? true : undefined), "the job to go silent");
  await checksPass();

  assert.deepEqual(await listed(worker), { [job]: true });
  assert.deepEqual(await findings(card, "job-lost"), []);
  assert.equal(await gone(stranger, job), false);
  assert.deepEqual(await listed(worker), { [job]: true });

  assert.equal(await gone(worker, job), true);
  assert.equal(await gone(worker, job), false);
  const [finding] = await findings(card, "job-lost");
  assert.equal(
    finding?.body,
    `job lost: job ${String(job)} (silent) is gone: its process no longer runs, and no result arrived. It is not run again.`,
  );
  assert.deepEqual(await listed(worker), {});
});

test("a job that still heartbeats is not lost by a report that its process is gone", async () => {
  const card = await newCard(fleet.main, "beating job");
  const token = await begin(fleet.main, card);
  const worker = await fleet.cardd.connect(token);
  const job = await startJob(worker, "beating");
  beats.push(
    setInterval(() => {
      fleet.cardd.post(token, "job.alive", { job }).catch(() => undefined);
    }, 40),
  );
  await checksPass();

  assert.equal(await gone(worker, job), false);
  assert.deepEqual(await listed(worker), { [job]: false });
  assert.deepEqual(await findings(card, "job-lost"), []);
});

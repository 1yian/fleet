import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, OPS, type Card, type Entry } from "@fleet/protocol";
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
  await fleet.cardd.stop();
});

const findings = async (card: Card): Promise<Entry[]> =>
  check(CardViewSchema, await fleet.main.call("card", { card: card.id })).entries.filter(
    (entry) => entry.kind === "finding" && entry.author === "check",
  );

function jobRow(id: number): Record<string, unknown> {
  const db = new DatabaseSync(fleet.cardd.db, { readOnly: true, timeout: 5000 });
  try {
    const row = db
      .prepare(
        `SELECT j.state AS state, j.dropped_at AS dropped_at, j.exit_code AS exit_code,
           a.state AS attempt, s.state AS session
         FROM jobs j JOIN attempts a ON a.id = j.attempt JOIN sessions s ON s.attempt = a.id
         WHERE j.id = ?`,
      )
      .get(id);
    if (row === undefined) throw new Error(`job ${String(id)} is missing`);
    return row;
  } finally {
    db.close();
  }
}

async function start(worker: Session, label: string): Promise<number> {
  return check(
    OPS["job.start"].result,
    await worker.call("job.start", { label, command: "sleep 99" }),
  ).job;
}

async function dropCard(card: Card): Promise<void> {
  await fleet.main.call("close.finish", {
    card: card.id,
    mode: "dropped",
    text: "closed while a job runs",
    archives: [],
    left: [],
  });
}

test("closing a card abandons its running job and does not call it lost", async () => {
  const card = await newCard(fleet.main, "closed under a running job");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const lost = await start(worker, "old");
  await fleet.main.waitForEntry(
    (entry) => entry.card === card.id && entry.fields["condition"] === "job-lost",
    "the silent job is lost",
  );
  const running = await start(worker, "server");
  const beat = setInterval(() => {
    worker.call("job.alive", { job: running }).catch(() => undefined);
  }, 20);
  beats.push(beat);
  await dropCard(card);
  clearInterval(beat);
  await assert.rejects(
    worker.call("job.alive", { job: running }),
    (error: unknown) => error instanceof Error && /closed/i.test(error.message),
  );

  const dropped = check(OPS["job.drop"].result, await fleet.main.call("job.drop", { job: lost }));
  const abandoned = check(
    OPS["job.drop"].result,
    await fleet.main.call("job.drop", { job: running }),
  );
  assert.deepEqual(dropped, { label: "old", state: "lost", dropped: true });
  assert.deepEqual(abandoned, { label: "server", state: "abandoned", dropped: false });
  const ended = jobRow(lost);
  assert.equal(ended["state"], "lost");
  assert.equal(ended["attempt"], "ended");
  const abandonedRow = jobRow(running);
  assert.equal(abandonedRow["state"], "abandoned");
  assert.equal(abandonedRow["dropped_at"], null);
  assert.equal(abandonedRow["exit_code"], null);
  assert.equal(abandonedRow["attempt"], "ended");
  assert.equal(abandonedRow["session"], "closed");
  const aboutServer = (await findings(card)).filter((entry) => entry.body.includes("(server)"));
  assert.deepEqual(aboutServer, []);
  const cutover = check(
    OPS["job.cutover"].result,
    await fleet.main.call("job.cutover", { action: "seal" }),
  );
  assert.equal(cutover.state, "draining");
  assert.deepEqual(
    cutover.blockers.map(({ job, state }) => [job, state]),
    [
      [lost, "lost"],
      [running, "abandoned"],
    ],
  );
});

test("an automatic stopped handoff is deferred while a reservation is outstanding and recorded once it ends", async () => {
  const card = await newCard(fleet.main, "Hand off only without a wait");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  await worker.call("report", { status: "working", text: "Starting the export" });
  const args = { launch: randomUUID(), label: "export", command: "echo export" };
  const { job } = check(OPS["job.prepare"].result, await worker.call("job.prepare", args));
  const stop = { status: "stopped-if-idle", text: "ended the run without a handoff" };
  const deferred = check(OPS.report.result, await worker.call("report", stop));
  assert.equal(deferred.deferred, true);
  const reports = async () =>
    check(CardViewSchema, await fleet.main.call("card", { card: card.id })).entries.filter(
      (entry) => entry.kind === "report" && entry.fields["status"] === "stopped",
    );
  assert.deepEqual(await reports(), []);

  assert.deepEqual(await worker.call("job.stop", { job }), {
    label: "export",
    running: false,
    cancelled: true,
  });
  const recorded = check(OPS.report.result, await worker.call("report", stop));
  assert.equal(recorded.deferred, undefined);
  assert.deepEqual(
    (await reports()).map((entry) => entry.body),
    ["ended the run without a handoff"],
  );
});

test("a reservation does not enter the job watch until the owning wrapper registers", async () => {
  const card = await newCard(fleet.main, "A prepare receipt never arrived");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const args = { launch: randomUUID(), label: "reserved", command: "echo reserved" };
  const prepared = check(OPS["job.prepare"].result, await worker.call("job.prepare", args));
  const { job } = prepared;
  assert.deepEqual(await worker.call("job.alive", { job }), { running: false });
  assert.deepEqual(await worker.call("jobs", {}), []);
  await assert.rejects(worker.call("job.prepare", { ...args, command: "true" }), /already in use/);

  const other = await newCard(fleet.main, "A separate attempt cannot replay the reservation");
  const stranger = await fleet.cardd.connect(await begin(fleet.main, other));
  await assert.rejects(stranger.call("job.prepare", args), /already in use/);
  const silent = await start(worker, "silent legacy control");
  await fleet.main.waitForEntry(
    (entry) =>
      entry.card === card.id &&
      entry.fields["job"] === silent &&
      entry.fields["condition"] === "job-lost",
    "a legacy job admitted after the reservation is detected as lost",
  );
  assert.deepEqual(
    (await findings(card))
      .filter((entry) => entry.fields["condition"] === "job-lost")
      .map((entry) => entry.fields["job"]),
    [silent],
  );
  assert.deepEqual(await worker.call("job.prepare", args), prepared);
  assert.deepEqual(await worker.call("job.register", { job, launch: args.launch, pid: 1234 }), {
    registered: true,
  });
  assert.deepEqual(await worker.call("jobs", {}), [{ id: job, label: args.label }]);
  assert.deepEqual(await worker.call("job.alive", { job }), { running: true });
  assert.deepEqual(await worker.call("job.prepare", args), {
    job,
    unavailable: "already registered",
  });
  await fleet.main.waitForEntry(
    (entry) =>
      entry.card === card.id &&
      entry.fields["job"] === job &&
      entry.fields["condition"] === "job-lost",
    "the silence detector also watches registered wrappers",
  );

  const pending = check(
    OPS["job.prepare"].result,
    await worker.call("job.prepare", { ...args, launch: randomUUID() }),
  );
  const launch = randomUUID();
  const cancelled = check(
    OPS["job.prepare"].result,
    await worker.call("job.prepare", { ...args, launch }),
  );
  await assert.rejects(stranger.call("job.stop", { job: cancelled.job }), /not one of/);
  assert.deepEqual(await worker.call("job.stop", { job: cancelled.job }), {
    label: args.label,
    running: false,
    cancelled: true,
  });
  assert.deepEqual(await worker.call("job.register", { job: cancelled.job, launch, pid: 1234 }), {
    registered: false,
  });
  assert.deepEqual(await worker.call("job.stop", { job: cancelled.job }), {
    label: args.label,
    running: false,
  });
  assert.equal(jobRow(cancelled.job)["exit_code"], 130);
  assert.deepEqual(await worker.call("job.prepare", { ...args, launch }), {
    job: cancelled.job,
    unavailable: "already finished: stopped before wrapper registration",
  });
  await dropCard(card);
  assert.equal(jobRow(pending.job)["state"], "abandoned");
});

test("a dropped lost job can still finish, and the drop mark does not survive finish", async () => {
  const card = await newCard(fleet.main, "late result after drop");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  const job = await start(worker, "server");
  await fleet.main.waitForEntry(
    (entry) => entry.card === card.id && entry.fields["condition"] === "job-lost",
    "the job is lost",
  );
  const dropped = check(OPS["job.drop"].result, await worker.call("job.drop", { job }));
  assert.deepEqual(dropped, { label: "server", state: "lost", dropped: true });
  const alive = check(OPS["job.alive"].result, await worker.call("job.alive", { job }));
  assert.equal(alive.running, false);
  const result = check(
    OPS["job.finish"].result,
    await worker.call("job.finish", { job, exitCode: 0, outputTail: "late result" }),
  );
  assert.equal(result.recorded, true);
  const row = jobRow(job);
  assert.equal(row["state"], "finished");
  assert.equal(row["dropped_at"], null);
  assert.equal(row["exit_code"], 0);
  const again = check(OPS["job.drop"].result, await worker.call("job.drop", { job }));
  assert.deepEqual(again, { label: "server", state: "finished", dropped: false });
});

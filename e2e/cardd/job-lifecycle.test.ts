import assert from "node:assert/strict";
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

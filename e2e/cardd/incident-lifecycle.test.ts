import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { check, OPS, type Entry } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { tempDir } from "../support/run-root.ts";

let fleet: Fleet | undefined;
afterEach(async () => fleet?.cardd.stop());

const ELIGIBLE = "is eligible for recovery now: restart_card";

function setClock(file: string, ms: number): void {
  const next = `${file}.next`;
  writeFileSync(next, new Date(ms).toISOString());
  renameSync(next, file);
}

async function started(): Promise<{ fleet: Fleet; clock: string }> {
  const dir = tempDir("incident-clock-");
  mkdirSync(dir, { recursive: true });
  const clock = join(dir, "clock");
  setClock(clock, Date.now());
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001", CARDD_CLOCK_FILE: clock });
  return { fleet, clock };
}

async function proveCheckRan(current: Fleet): Promise<void> {
  const witness = await newCard(current.main, "A poll witness");
  await begin(current.main, witness);
  await current.main.waitForEntry(
    (entry) => entry.card === witness.id && entry.fields["condition"] === "worker-never-connected",
    "the poll after the clock advances",
  );
}

function incidentRow(dbPath: string, card: number): Record<string, unknown> {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    const row = db
      .prepare("SELECT id, state, intent, closed_at FROM incidents WHERE card = ?")
      .get(card);
    if (row === undefined) throw new Error(`no incident for c-${String(card)}`);
    return row;
  } finally {
    db.close();
  }
}

function notices(entries: readonly Entry[]): Entry[] {
  return entries.filter((entry) => entry.body.includes(ELIGIBLE));
}

test("closing a card supersedes its live incident and does not announce recovery", async () => {
  const { fleet: current, clock } = await started();
  const card = await newCard(current.main, "closed under an incident");
  const worker = await current.cardd.connect(await begin(current.main, card));
  await worker.call("incident.report", { error: "429 rate limit, try later" });
  await current.main.call("close.finish", {
    card: card.id,
    mode: "dropped",
    text: "dropped while its incident is open",
    archives: [],
    left: [],
  });
  setClock(clock, Date.now() + 60_000);
  await proveCheckRan(current);
  const thread = check(OPS.card.result, await current.main.call("card", { card: card.id }));
  const row = incidentRow(current.cardd.db, card.id);
  assert.equal(thread.card.status, "dropped");
  assert.deepEqual(notices(thread.entries), []);
  assert.equal(row["state"], "superseded");
  assert.equal(typeof row["closed_at"], "number");
});

test("an open incident does not announce recovery after its card pauses", async () => {
  const { fleet: current, clock } = await started();
  const card = await newCard(current.main, "paused under an incident");
  const worker = await current.cardd.connect(await begin(current.main, card));
  await worker.call("incident.report", { error: "429 rate limit, try later" });
  await worker.call("report", {
    status: "paused",
    text: "waiting on the vendor",
    until: Date.now() + 3_600_000,
  });
  setClock(clock, Date.now() + 60_000);
  await proveCheckRan(current);
  const thread = check(OPS.card.result, await current.main.call("card", { card: card.id }));
  const row = incidentRow(current.cardd.db, card.id);
  assert.equal(thread.card.status, "paused");
  assert.deepEqual(notices(thread.entries), []);
  assert.equal(row["state"], "open");
  assert.equal(row["intent"], "working");
});

test("an incident intent outside the lifecycle is rejected by the database", async () => {
  const { fleet: current } = await started();
  const card = await newCard(current.main, "intent constraint");
  const worker = await current.cardd.connect(await begin(current.main, card));
  const reported = check(
    OPS["incident.report"].result,
    await worker.call("incident.report", { error: "429 rate limit, try later" }),
  );
  const db = new DatabaseSync(current.cardd.db, { timeout: 5000 });
  try {
    assert.throws(
      () => db.prepare("UPDATE incidents SET intent = 'nope' WHERE id = ?").run(reported.incident),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => db.prepare("UPDATE incidents SET state = 'nope' WHERE id = ?").run(reported.incident),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { check, OPS, type Card, type Entry } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import type { Session } from "../support/cardd.ts";

let fleet: Fleet;
afterEach(async () => fleet.cardd.stop());

const processNotice = (entry: Entry, card: Card): boolean =>
  entry.card === card.id &&
  ["worker-never-connected", "worker-not-connected"].includes(String(entry.fields["condition"]));

async function exhaust(mate: Session, card: Card, phase: string): Promise<Entry> {
  const initial = await mate.waitForEntry(
    (entry) => entry.card === card.id && entry.fields["condition"] === phase,
    "the initial process failure",
  );
  const ids = /Incident (\d+), process generation (\d+)/.exec(initial.body);
  assert.ok(ids !== null, initial.body);
  await mate.call("card.restart", {
    card: card.id,
    incident: Number(ids[1]),
    generation: Number(ids[2]),
    mode: "replace",
    key: `incident-${ids[1] ?? ""}`,
  });
  await mate.waitForEntry(
    (entry) =>
      entry.card === card.id && entry.id > initial.id && entry.body.includes("did not verify"),
    "the exhaustion notice after failed replacement",
  );
  await assert.rejects(
    mate.call("card.restart", {
      card: card.id,
      incident: Number(ids[1]),
      generation: Number(ids[2]),
      mode: "replace",
      key: "over-budget",
    }),
    /is blocked/,
  );
  return initial;
}

async function severalChecks(mate: Session): Promise<void> {
  const witness = await newCard(mate, "notification clock witness");
  await begin(mate, witness);
  await mate.waitForEntry(
    (entry) =>
      entry.card === witness.id &&
      entry.fields["condition"] === "worker-never-connected" &&
      Number(entry.fields["tier"]) >= 4,
    "several reminder intervals",
  );
}

async function stableExhaustion(mate: Session, card: Card, initial: Entry): Promise<void> {
  const notice = await mate.waitForEntry(
    (entry) =>
      entry.id > initial.id &&
      processNotice(entry, card) &&
      entry.body.includes("1 of 1 replacement"),
    "one actionable exhausted process notice",
  );
  assert.match(notice.body, /process generation \d+/);
  assert.match(notice.body, /restart_card\(card=\d+\) without incident/);
  assert.match(notice.body, /direct-parent, card-state, and 3-per-hour/);
  const before = check(OPS.card.result, await mate.call("card", { card: card.id })).entries.filter(
    (entry) => processNotice(entry, card),
  );
  await severalChecks(mate);
  const after = check(OPS.card.result, await mate.call("card", { card: card.id })).entries.filter(
    (entry) => processNotice(entry, card),
  );
  assert.deepEqual(
    after.map((entry) => entry.id),
    before.map((entry) => entry.id),
  );
  assert.ok(after.some((entry) => entry.id === notice.id));
}

test("spent process recovery has one durable notice per incident and new generations remain visible", async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
  const card = await newCard(fleet.main, "recover a missing worker");
  const token = await begin(fleet.main, card);
  const first = await exhaust(fleet.main, card, "worker-never-connected");
  await stableExhaustion(fleet.main, card, first);
  const worker = await fleet.cardd.connect(token);
  await worker.lose();
  const next = await exhaust(fleet.main, card, "worker-not-connected");
  assert.ok(next.id > first.id);
  assert.notEqual(
    /Incident \d+, process generation \d+/.exec(next.body)?.[0],
    /Incident \d+, process generation \d+/.exec(first.body)?.[0],
  );
  await stableExhaustion(fleet.main, card, next);
});

test("ordinary restart stays independent of spent incident recovery and keeps its admission guards", async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const card = await newCard(cleo, "independent restart admission");
  const token = await begin(cleo, card);
  await exhaust(cleo, card, "worker-never-connected");
  await assert.rejects(
    fleet.main.call("card.restart", { card: card.id, mode: "replace", key: "foreign" }),
    /only the direct parent/,
  );
  for (const key of ["ordinary-1", "ordinary-2", "ordinary-3"]) {
    const plan = check(
      OPS["card.restart"].result,
      await cleo.call("card.restart", { card: card.id, mode: "replace", key }),
    );
    assert.equal(plan.incident, null);
    assert.equal(plan.repeat, false);
  }
  const repeat = check(
    OPS["card.restart"].result,
    await cleo.call("card.restart", { card: card.id, mode: "replace", key: "ordinary-3" }),
  );
  assert.equal(repeat.repeat, true);
  await assert.rejects(
    cleo.call("card.restart", { card: card.id, mode: "replace", key: "ordinary-4" }),
    /was restarted 3 times in the last hour/,
  );
  const worker = await fleet.cardd.connect(token);
  await worker.call("report", {
    status: "paused",
    text: "wait for credentials",
    until: Date.now() + 60_000,
  });
  await assert.rejects(
    cleo.call("card.restart", { card: card.id, mode: "replace", key: "paused" }),
    /card is paused.*worker is connected/,
  );
  const thread = await fleet.cardd.thread(card.id);
  assert.equal(
    thread.entries.filter((entry) => entry.fields["restartKey"] !== undefined).length,
    3,
  );
  assert.equal(thread.card.status, "paused");
});

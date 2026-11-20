import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { missedAbout, untakenControl } from "../support/missed.ts";

const TURN_FAILED = "provider exploded: code 61";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.01" });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const isFailure = (entry: Entry): boolean => entry.fields["condition"] === "runtime-failure";
const isCheck = (entry: Entry): boolean => entry.fields["recovery"] !== undefined;
const checksSent = (worker: Session): number =>
  worker.entries.filter((push) => isCheck(push.entry)).length;

function recoveryOf(heard: Entry): { card: number; incident: number; generation: number } {
  const [, incident, generation] =
    /Incident (\d+), process generation (\d+)/.exec(heard.body) ?? [];
  return { card: heard.card, incident: Number(incident), generation: Number(generation) };
}

async function failedWorker(phase: "turn" | "compaction"): Promise<{
  worker: Session;
  token: string;
  card: number;
  incident: number;
  generation: number;
}> {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const token = await begin(fleet.main, card);
  const worker = await fleet.cardd.connect(token, [], false);
  const [task] = await worker.waitForEntries(1);
  worker.ack(task?.id ?? 0);
  await worker.call("incident.report", { error: TURN_FAILED, phase });
  const heard = await fleet.main.waitForEntry(isFailure, "the failure to reach the mate");
  return { worker, token, ...recoveryOf(heard) };
}

test("a recovery check whose compaction verified is never sent again or reported missed", async () => {
  const { worker, card, incident, generation } = await failedWorker("compaction");
  await fleet.main.call("card.restart", {
    card,
    incident,
    generation,
    mode: "retry",
    key: "retry",
  });
  const [, check] = await worker.waitForEntries(2);
  assert.equal(check?.fields["compaction"], true);
  await worker.call("incident.clear", { compacted: true });
  await fleet.main.waitForEntry(
    (entry) => entry.body.includes("recovered (retry)"),
    "the compaction recovery to verify",
  );

  const control = await untakenControl(fleet, "A task nobody takes in");
  await control.reportedMissed();

  assert.equal(checksSent(worker), 1);
  assert.deepEqual(missedAbout(fleet, card), []);
  await Promise.all([worker.close(), control.worker.close()]);
});

test("a recovery check the worker read and answered is never sent again or reported missed once the worker carries on", async () => {
  const { worker, card, incident, generation } = await failedWorker("turn");
  await fleet.main.call("card.restart", {
    card,
    incident,
    generation,
    mode: "retry",
    key: "retry",
  });
  const [, check] = await worker.waitForEntries(2);
  worker.read(check?.id ?? 0);
  await worker.call("report", { status: "note", text: "alive, working on the scrollbar" });
  await fleet.main.waitForEntry(
    (entry) => entry.card === card && entry.body.includes("did not verify"),
    "the verification window to pass without an acknowledgement",
  );
  await worker.call("incident.clear", {});

  const control = await untakenControl(fleet, "A task nobody takes in");
  await control.reportedMissed();

  assert.equal(checksSent(worker), 1);
  assert.deepEqual(missedAbout(fleet, card), []);
  await Promise.all([worker.close(), control.worker.close()]);
});

test("a mate's unverified recovery check replays after read or acknowledgement", async () => {
  const token = fleet.cardd.addLane("cleo", "main");
  const mate = await fleet.cardd.connect(token, [], false);
  await mate.call("incident.report", { error: TURN_FAILED });
  const heard = await fleet.main.waitForEntry(isFailure, "the second mate's failure");
  const { card, incident, generation } = recoveryOf(heard);
  await fleet.main.call("card.restart", {
    card,
    incident,
    generation,
    mode: "retry",
    key: "retry",
  });
  const probe = await mate.waitForEntry(isCheck, "the second mate's recovery check");
  mate.read(probe.id);
  await mate.call("card", { card });
  await mate.lose();

  const afterRead = await fleet.cardd.connect(token, [], false);
  await afterRead.call("card", { card });
  assert.equal(afterRead.entries.find(({ entry }) => isCheck(entry))?.entry.id, probe.id);
  afterRead.ack(probe.id);
  await afterRead.call("card", { card });
  await afterRead.lose();

  const afterAck = await fleet.cardd.connect(token, [], false);
  await afterAck.call("card", { card });
  assert.equal(afterAck.entries.find(({ entry }) => isCheck(entry))?.entry.id, probe.id);
  await afterAck.call("board", {});
  await fleet.main.waitForEntry(
    (entry) => entry.card === card && entry.body.includes("recovered (retry)"),
    "the mate's recovery to verify after the board call",
  );
  await afterAck.close();
});

for (const signal of ["read", "report"] as const) {
  test(`a ${signal} alone ends replay and unblocks handoff during recovery`, async () => {
    const { worker, token, card, incident, generation } = await failedWorker("turn");
    const retry = { card, incident, generation, mode: "retry", key: "retry" };
    await fleet.main.call("card.restart", retry);
    const probe = await worker.waitForEntry(isCheck, "the recovery check");
    const handoff = { status: "done", text: "the scrollbar is fixed" };
    await assert.rejects(worker.call("report", handoff), /1 unread comment/);

    if (signal === "read") {
      worker.read(probe.id);
      await worker.call("jobs", {});
    } else {
      await worker.call("report", { status: "note", text: "alive, fixing the scrollbar" });
    }
    await worker.lose();

    const back = await fleet.cardd.connect(token, [], false);
    await back.call("jobs", {});
    assert.equal(checksSent(back), 0);
    await assert.rejects(
      fleet.main.call("card.restart", { ...retry, key: "another-retry" }),
      /already has a recovery in progress/,
    );
    await back.call("report", handoff);
    await back.close();
  });
}

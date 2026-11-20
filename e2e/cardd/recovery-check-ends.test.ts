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
  const [, incident, generation] =
    /Incident (\d+), process generation (\d+)/.exec(heard.body) ?? [];
  return {
    worker,
    token,
    card: card.id,
    incident: Number(incident),
    generation: Number(generation),
  };
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

test("a recovery check the worker read and answered is not sent again when the worker reconnects mid-recovery", async () => {
  const { worker, token, card, incident, generation } = await failedWorker("turn");
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
  await worker.lose();

  const back = await fleet.cardd.connect(token, [], false);
  const control = await untakenControl(fleet, "A task nobody takes in");
  await control.reportedMissed();

  assert.equal(checksSent(back), 0);
  assert.deepEqual(missedAbout(fleet, card), []);
  await Promise.all([back.close(), control.worker.close()]);
});

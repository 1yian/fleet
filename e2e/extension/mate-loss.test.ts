import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Entry } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.02" });
  h = await Harness.start();
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

const isFailure = (entry: Entry): boolean => entry.fields["condition"] === "runtime-failure";

async function laterCheck(): Promise<void> {
  const witness = await newCard(fleet.main, "a later card");
  await begin(fleet.main, witness);
  await fleet.main.waitForEntry(
    (entry) => entry.card === witness.id && entry.fields["condition"] === "worker-never-connected",
    "a check pass after the loss",
  );
}

async function connectedMate(lane: string) {
  const env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: fleet.cardd.addLane(lane, "main"),
    FLEET_ROLE: "mate",
  };
  const pi = h.startPi(lane, env, [EXTENSION]);
  await h.waitForNth((event) => event["type"] === "fleet_connected", 1, `${lane} to connect`);
  return pi;
}

test("a second mate whose process is killed with no final event raises one incident that only main hears", async () => {
  const pi = await connectedMate("cleo");
  await pi.kill();
  const heard = await fleet.main.waitForEntry(isFailure, "the lost mate");

  assert.match(
    heard.body,
    /^runtime failure: cleo its process stopped without a final event\. Classified unknown\. Incident 1, process generation 1\. Recover with restart_card\(card=\d+, incident=1, generation=1, mode=replace\)\.$/,
  );
  await laterCheck();
  assert.equal(fleet.main.entries.filter((push) => isFailure(push.entry)).length, 1);
});

test("a second mate that main stopped on purpose is not reported as lost", async () => {
  const pi = await connectedMate("leo");
  await fleet.main.call("lane.stopping", { lane: "leo" });
  await pi.kill();
  await laterCheck();

  assert.equal(fleet.main.entries.filter((push) => isFailure(push.entry)).length, 0);
  await assert.rejects(
    fleet.main.call("lane.stopping", { lane: "main" }),
    /is not one of your second mates/,
  );
});

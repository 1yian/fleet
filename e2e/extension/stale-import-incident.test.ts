import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, type Card, type Entry } from "@fleet/protocol";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
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

async function thread(card: Card): Promise<Entry[]> {
  return check(CardViewSchema, await fleet.main.call("card", { card: card.id })).entries;
}

async function laterCheck(): Promise<void> {
  const witness = await newCard(fleet.main, "a later card");
  await begin(fleet.main, witness);
  await fleet.main.waitForEntry(
    (entry) => entry.card === witness.id && entry.fields["condition"] === "worker-never-connected",
    "a check pass after the failure",
  );
}

async function worker(card: Card): Promise<void> {
  const env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: await begin(fleet.main, card, "the task"),
    FLEET_ROLE: "worker",
  };
  h.startPi(`c-${String(card.id)}-a1`, env, [EXTENSION]);
}

const STALE =
  "Cannot find module '/pi/dist/bundle/chunks/openai-completions-BGCEXFAB.js' imported from /pi/dist/bundle/chunk-66G7ITPS.js";

async function assertStaleIncident(card: Card): Promise<void> {
  const heard = await fleet.main.waitForEntry(isFailure, "the stale module incident");
  assert.match(heard.body, /Classified stale-module\. Incident 1, process generation 1\./);
  assert.match(heard.body, /mode=replace\)\.$/);
  await laterCheck();
  const entries = await thread(card);
  assert.equal(entries.filter(isFailure).length, 1);
  assert.deepEqual(
    entries.filter((entry) => entry.fields["status"] === "stopped"),
    [],
  );
  assert.equal(await status(fleet.main, card), "working");
}

test("an import failure at the start of a turn opens one stale-module incident with a generation, and no stopped report", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  h.onModel(() => ({ fail: STALE }));
  await worker(card);
  await assertStaleIncident(card);
});

test("an import failure on the nudge turn after a run without a handoff opens one stale-module incident, and no stopped report", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  h.onModel(() => ({ text: "I think I am done" }));
  h.onModel(() => ({ fail: STALE }));
  await worker(card);
  await assertStaleIncident(card);
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, park, startFleet, type Fleet } from "../support/fleet.ts";
import { until } from "../support/live-fleet.ts";

const SCALE = 0.0002;
const DAY = 24 * 3_600_000 * SCALE;
const HOUR = 3_600_000;

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: String(SCALE) });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const isList = (entry: Entry): boolean =>
  entry.author === "check" && entry.fields["condition"] === "decisions";

const lists = (session: Session): Entry[] =>
  session.entries.map(({ entry }) => entry).filter(isList);

test("a mate with only dated waits hears no list on the 30 minute cadence, hears one information list after a day, and not again after a restart", async () => {
  const quota = await newCard(fleet.main, "Waits on the quota");
  const held = Date.now();
  await park(fleet.main, quota, "Quota resets?", HOUR);

  const first = await until(() => lists(fleet.main)[0], "the information list");
  assert.ok(
    Date.now() - held >= DAY,
    "no list arrived before a day: the 30 minute cadence does not start one",
  );
  assert.match(
    first.body,
    /^information: 1 dated wait, nothing needs action\. Date a hold only when a process or an outside event is the blocker/,
  );
  assert.doesNotMatch(first.body, /card needs|cards need|a decision or action from you/);
  assert.match(first.body, /Information only, no action now:/);
  assert.deepEqual(first.body.match(/c-\d+/g), [`c-${String(quota.id)}`]);
  assert.deepEqual(lists(fleet.main), [first]);

  await fleet.cardd.restart();
  const main = await fleet.cardd.connect(fleet.mainToken);
  const quinn = await fleet.cardd.connect(fleet.cardd.addLane("quinn", "main"));
  const stuck = await newCard(quinn, "Quinn blocker");
  const worker = await fleet.cardd.connect(await begin(quinn, stuck));
  await worker.call("report", { status: "blocked", text: "stuck" });
  await quinn.waitForEntry(
    (entry) => isList(entry) && Number(entry.fields["tier"]) >= 2,
    "two lists for quinn, so more than one 30 minute cadence has passed",
  );
  assert.deepEqual(
    lists(main).filter((entry) => entry.id !== first.id),
    [],
    "the information list is not sent again right after a restart",
  );
});

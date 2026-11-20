import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Entry } from "@fleet/protocol";
import {
  ageDelivery,
  begin,
  CheckPasses,
  MINUTE,
  newCard,
  startFleet,
  type Fleet,
} from "../support/fleet.ts";

const MISSED =
  "missed: cleo did not take in this report from the worker, re-sent 3 times: The API is down";

let fleet: Fleet;
let passes: CheckPasses;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_CHECK_EVERY_MS: "50" });
  passes = await CheckPasses.open(fleet);
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const missedOf = (entry: Entry): boolean => entry.fields["condition"] === "missed";

test("a report a second mate never takes in is sent again every two minutes, and main hears after the third resend and again every fifteen minutes", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"), [], false);
  const main = await fleet.cardd.connect(fleet.mainToken, [], false);
  const card = await newCard(cleo, "Users see one scrollbar");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "blocked", text: "The API is down\nlogs in /tmp/x" });

  const [report] = await cleo.waitForEntries(1);
  assert.equal(report?.kind, "report");
  for (const resend of [1, 2, 3]) {
    ageDelivery(fleet.cardd, "cleo", report.id, "updated_at", 3 * MINUTE);
    await cleo.waitForEntries(1 + resend);
  }

  const missed = await main.waitForEntry(missedOf, "main to hear that cleo missed the report");
  assert.equal(missed.body, MISSED);
  const resent = cleo.entries.map(({ entry, again }) => [entry.body, again ?? false]);
  assert.deepEqual(resent[0], ["The API is down\nlogs in /tmp/x", false]);
  assert.ok(resent.length >= 4, `cleo was sent the report ${String(resent.length)} times`);
  assert.ok(
    resent.slice(1).every(([body, again]) => String(body).startsWith("The API is down") && again),
  );

  ageDelivery(fleet.cardd, "cleo", report.id, "told_at", 14 * MINUTE);
  await passes.next();
  assert.deepEqual(
    main.entries.map(({ entry }) => entry).filter(missedOf),
    [missed],
    "main heard again before fifteen minutes had passed",
  );
  ageDelivery(fleet.cardd, "cleo", report.id, "told_at", MINUTE);
  const repeated = await main.waitForEntry(
    (entry) =>
      entry.id > missed.id && missedOf(entry) && entry.fields["entry"] === missed.fields["entry"],
    "main to hear the same unread obligation again after fifteen minutes",
  );
  assert.equal(repeated.body, MISSED);
  await worker.close();
});

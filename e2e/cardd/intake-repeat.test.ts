import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Entry } from "@fleet/protocol";
import {
  ageDelivery,
  begin,
  CheckPasses,
  MINUTE,
  newCard,
  park,
  startFleet,
  status,
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

for (const receipt of ["read", "filed"] as const) {
  test(`a ${receipt} restart notice retired while waiting cannot return after release`, async () => {
    const { main, cardd } = fleet;
    const card = await newCard(main, "Keep the restart notice out of resumed work");
    const token = await begin(main, card);
    const first = await cardd.connect(token, [], false, true);
    const [task] = await first.waitForEntries(1);
    assert.ok(task !== undefined);
    const { request } = check(
      OPS["card.restart"].result,
      await main.call("card.restart", { card: card.id, mode: "replace", key: "older" }),
    );
    assert.ok(request !== undefined);
    assert.deepEqual(await main.call("card.restart.notice", { card: card.id, request }), {
      posted: true,
    });
    const original = await first.waitForEntry(
      (entry) => entry.fields["restartNotice"] === request,
      "the original restart notice",
    );
    first.read(original.id);
    await first.call("jobs", {});
    await first.close();

    await park(main, card, "wait for CI", 60 * MINUTE);
    assert.equal(await status(main, card), "waiting");
    const inFile = receipt === "filed" ? [task.id, original.id] : [task.id];
    const waiting = await cardd.connect(token, inFile, false);
    const actor = waiting.welcome?.session;
    assert.ok(actor !== undefined);
    if (receipt === "filed") {
      ageDelivery(cardd, actor, original.id, "updated_at", 3 * MINUTE);
      await passes.next();
    }
    await waiting.call("jobs", {});
    assert.deepEqual(
      waiting.entries.filter(({ entry }) => entry.id === original.id),
      [],
    );
    if (receipt === "read") await waiting.close();

    await main.call("release", { card: card.id, source: "chat", words: "CI is done" });
    const text = "Check the footer now that CI is done.";
    await main.call("comment", { card: card.id, text });
    assert.equal(await status(main, card), "working");
    const resumed = receipt === "filed" ? waiting : await cardd.connect(token, [task.id], false);
    const steer = await resumed.waitForEntry((entry) => entry.body === text, "the resume comment");
    if (receipt === "filed") {
      ageDelivery(cardd, actor, steer.id, "updated_at", 3 * MINUTE);
      await passes.next();
      await resumed.call("jobs", {});
      assert.deepEqual(
        resumed.entries.filter(({ entry }) => entry.id === steer.id).map(({ again }) => again),
        [false, true],
      );
    }
    assert.deepEqual(
      resumed.entries.filter(({ entry }) => entry.id === original.id),
      [],
    );
    assert.ok((await cardd.thread(card.id)).entries.some(({ id }) => id === original.id));
  });
}

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

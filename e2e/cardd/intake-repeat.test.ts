import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, OPS, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
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

function deliveryReceipt(path: string, session: string, entry: number) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    return db
      .prepare(
        "SELECT state, updated_at, resends, told_at FROM deliveries WHERE session = ? AND entry = ?",
      )
      .get(session, entry);
  } finally {
    db.close();
  }
}

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
    const waiting = await cardd.connect(token, inFile, false, true);
    const actor = waiting.welcome?.session;
    assert.ok(actor !== undefined);
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
      ageDelivery(cardd, actor, original.id, "updated_at", 3 * MINUTE);
      ageDelivery(cardd, actor, steer.id, "updated_at", 3 * MINUTE);
      const before = deliveryReceipt(cardd.db, actor, original.id);
      assert.equal(before?.["state"], "filed");
      assert.equal(before["resends"], 0);
      resumed.send({ t: "activity", state: "idle" });
      await resumed.call("jobs", {});
      await passes.next();
      await resumed.call("jobs", {});
      assert.deepEqual(
        resumed.entries.filter(({ entry }) => entry.id === steer.id).map(({ again }) => again),
        [false, true],
      );
      assert.deepEqual(
        resumed.entries.filter(({ entry }) => entry.id === original.id),
        [],
      );
      assert.deepEqual(deliveryReceipt(cardd.db, actor, original.id), before);
    }
    assert.deepEqual(
      resumed.entries.filter(({ entry }) => entry.id === original.id),
      [],
    );
    assert.ok((await cardd.thread(card.id)).entries.some(({ id }) => id === original.id));
  });
}

function copies(session: Session, id: number): Entry[] {
  return session.entries.map(({ entry }) => entry).filter((entry) => entry.id === id);
}

async function missedAfterResends(main: Session, worker: Session, source: Entry): Promise<Entry> {
  const actor = worker.welcome?.session;
  assert.ok(actor !== undefined);
  for (const count of [2, 3, 4]) {
    ageDelivery(fleet.cardd, actor, source.id, "updated_at", 3 * MINUTE);
    await worker.waitForEntry(
      (entry) => entry.id === source.id && copies(worker, source.id).length >= count,
      `copy ${String(count)} of entry ${String(source.id)}`,
    );
  }
  return main.waitForEntry(
    (entry) => missedOf(entry) && entry.fields["entry"] === source.id,
    `main to hear that entry ${String(source.id)} was missed`,
  );
}

for (const by of ["hold", "refund", "incident replacement", "generation advance"] as const) {
  test(`a restart notice retired by ${by} stops replay and chase of its missed finding`, async () => {
    const { cardd, mainToken } = fleet;
    const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
    const main = await cardd.connect(mainToken, [], false, true);
    const card = await newCard(cleo, "Keep only live missed findings");
    const token = await begin(cleo, card);
    const worker = await cardd.connect(token, [], false);
    const [task] = await worker.waitForEntries(1);
    assert.ok(task !== undefined);
    worker.ack(task.id);
    await worker.call("jobs", {});

    const key = "refundable-start";
    const { request } = check(
      OPS["card.restart"].result,
      await cleo.call("card.restart", { card: card.id, mode: "replace", key }),
    );
    assert.ok(request !== undefined);
    assert.deepEqual(await cleo.call("card.restart.notice", { card: card.id, request }), {
      posted: true,
    });
    const notice = await worker.waitForEntry(
      (entry) => entry.fields["restartNotice"] === request,
      "the restart notice",
    );
    const missed = await missedAfterResends(main, worker, notice);
    const text = "Check the footer as well.";
    await cleo.call("comment", { card: card.id, text });
    const steer = await worker.waitForEntry((entry) => entry.body === text, "the ordinary comment");
    const ordinary = await missedAfterResends(main, worker, steer);
    await main.close();

    if (by === "hold") {
      await park(cleo, card, "Wait for CI", 60 * MINUTE);
      assert.equal(await status(cleo, card), "waiting");
    } else if (by === "refund") {
      assert.deepEqual(await cleo.call("card.restart.failed", { card: card.id, key, request }), {
        recorded: true,
      });
    } else if (by === "incident replacement") {
      const { incident } = check(
        OPS["incident.report"].result,
        await worker.call("incident.report", { error: "something odd happened" }),
      );
      await worker.close();
      const plan = check(
        OPS["card.restart"].result,
        await cleo.call("card.restart", {
          card: card.id,
          incident,
          generation: 1,
          mode: "replace",
          key: "incident-replacement",
        }),
      );
      assert.equal(plan.repeat, false);
    } else {
      await worker.close();
      const nextKey = "new-worker-process";
      const next = check(
        OPS["card.restart"].result,
        await cleo.call("card.restart", { card: card.id, mode: "replace", key: nextKey }),
      );
      assert.ok(next.request !== undefined);
      assert.equal(cardd.startNewProcess(token), true);
      const replacement = await cardd.connect(token, [task.id, notice.id, steer.id], false, true);
      await replacement.call("jobs", {});
      assert.deepEqual(copies(replacement, notice.id), []);
      assert.deepEqual(
        await cleo.call("card.restart.failed", {
          card: card.id,
          key: nextKey,
          request: next.request,
        }),
        { recorded: false },
      );
    }

    const reconnected = await cardd.connect(mainToken, [], false, true);
    await reconnected.waitForEntry(
      (entry) => entry.id === ordinary.id,
      "the live finding to replay",
    );
    const replayed = copies(reconnected, missed.id);
    const actor = reconnected.welcome?.session;
    assert.ok(actor !== undefined);
    for (const id of [missed.id, ordinary.id])
      ageDelivery(cardd, actor, id, "updated_at", 3 * MINUTE);
    const before = deliveryReceipt(cardd.db, actor, missed.id);
    assert.equal(before?.["state"], "pushed");
    reconnected.send({ t: "activity", state: "idle" });
    await reconnected.call("board", {});
    await passes.next();
    await reconnected.call("board", {});
    assert.deepEqual(copies(reconnected, ordinary.id), [ordinary, ordinary]);
    assert.deepEqual([replayed, copies(reconnected, missed.id)], [[], []]);
    assert.deepEqual(deliveryReceipt(cardd.db, actor, missed.id), before);
    const history = check(CardViewSchema, await reconnected.call("card", { card: card.id }));
    assert.deepEqual(
      history.entries.find(({ id }) => id === missed.id),
      missed,
    );
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

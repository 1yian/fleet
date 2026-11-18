import assert from "node:assert/strict";
import { test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { begin, newCard, startFleet } from "../support/fleet.ts";

test("overlapping reload batches retain verified receipts and shared pending membership across retries and restart", async () => {
  const fleet = await startFleet();
  const connections = [fleet.main];
  try {
    const cards = [await newCard(fleet.main, "X"), await newCard(fleet.main, "Y")];
    const tokens = await Promise.all(cards.map((card) => begin(fleet.main, card)));
    const workers = await Promise.all(
      tokens.map((token) => fleet.cardd.connect(token, [], true, false, true)),
    );
    connections.push(...workers);
    const request = async (batch: string) =>
      check(
        OPS["maintenance.request"].result,
        await fleet.main.call("maintenance.request", { batch, kind: "reload" }),
      );
    const a = await request("A");
    const [x, y] = workers;
    const [tokenX, tokenY] = tokens;
    const requestX = a.find((row) => row.session === "c-1-a1");
    const requestY = a.find((row) => row.session === "c-2-a1");
    assert.ok(x && y && tokenX && tokenY && requestX && requestY);
    const replacementX = await fleet.cardd.replace(x, tokenX, requestX.id);
    connections.push(replacementX);
    const b = await request("B");
    const shared = b.find((row) => row.session === "c-2-a1");
    assert.ok(shared);
    assert.equal(shared.id, requestY.id);
    assert.equal(shared.batch, "B");
    assert.deepEqual(
      check(
        OPS["maintenance.status"].result,
        await fleet.main.call("maintenance.status", { batch: "A" }),
      ).map((row) => row.state),
      ["completed", "pending"],
    );
    await request("B");
    const requestX2 = b.find((row) => row.session === "c-1-a1");
    assert.ok(requestX2);
    assert.notEqual(requestX2.id, requestX.id);
    connections.push(await fleet.cardd.replace(y, tokenY, requestY.id));
    const summaryA = await fleet.main.waitForEntry(
      (entry) => entry.fields["maintenanceBatch"] === "A",
      "A to summarize its original membership",
    );
    assert.match(summaryA.body, /2 reloaded and verified, 0 failed/);
    connections.push(await fleet.cardd.replace(replacementX, tokenX, requestX2.id));
    const summaryB = await fleet.main.waitForEntry(
      (entry) => entry.fields["maintenanceBatch"] === "B",
      "B to summarize its verified membership",
    );
    assert.match(summaryB.body, /2 reloaded and verified, 0 failed/);
    await Promise.all(connections.map((session) => session.close()));
    await fleet.cardd.restart();
    const main = await fleet.cardd.connect(fleet.mainToken);
    connections.push(main);
    for (const batch of ["A", "B"]) {
      await main.call("maintenance.request", { batch, kind: "reload" });
      const rows = check(
        OPS["maintenance.status"].result,
        await main.call("maintenance.status", { batch }),
      );
      assert.deepEqual(
        rows.map((row) => row.state),
        ["completed", "completed"],
      );
    }
    for (const [batch, summary] of [
      ["A", summaryA],
      ["B", summaryB],
    ] as const) {
      const history = check(OPS.card.result, await main.call("card", { card: summary.card }));
      assert.equal(
        history.entries.filter((entry) => entry.fields["maintenanceBatch"] === batch).length,
        1,
      );
    }
    assert.equal(fleet.cardd.summaryCount(), 2);
  } finally {
    await Promise.all(connections.map((session) => session.close()));
    await fleet.cardd.stop();
  }
});

test("a finalized reload batch rejects late new and already-pending targets on retries across restart", async () => {
  const fleet = await startFleet();
  const connections = [fleet.main];
  try {
    const card = await newCard(fleet.main, "original member");
    const token = await begin(fleet.main, card);
    const original = await fleet.cardd.connect(token, [], true, false, true);
    connections.push(original);
    const [first] = check(
      OPS["maintenance.request"].result,
      await fleet.main.call("maintenance.request", { batch: "finalized", kind: "reload" }),
    );
    assert.ok(first);
    connections.push(await fleet.cardd.replace(original, token, first.id));
    const summary = await fleet.main.waitForEntry(
      (entry) => entry.fields["maintenanceBatch"] === "finalized",
      "the original member's summary",
    );
    assert.match(summary.body, /1 reloaded and verified, 0 failed/);
    const expected = check(
      OPS["maintenance.status"].result,
      await fleet.main.call("maintenance.status", { batch: "finalized" }),
    );
    const pendingToken = await begin(fleet.main, await newCard(fleet.main, "already pending"));
    connections.push(await fleet.cardd.connect(pendingToken, [], true, false, true));
    await fleet.main.call("maintenance.request", { batch: "still-open", kind: "reload" });
    const newToken = await begin(fleet.main, await newCard(fleet.main, "new target"));
    connections.push(await fleet.cardd.connect(newToken, [], true, false, true));
    const retry = check(
      OPS["maintenance.request"].result,
      await fleet.main.call("maintenance.request", { batch: "finalized", kind: "reload" }),
    );
    assert.deepEqual(retry, expected);
    await Promise.all(connections.map((session) => session.close()));
    await fleet.cardd.restart();
    const main = await fleet.cardd.connect(fleet.mainToken);
    connections.push(main);
    assert.deepEqual(
      check(
        OPS["maintenance.request"].result,
        await main.call("maintenance.request", { batch: "finalized", kind: "reload" }),
      ),
      expected,
    );
    const history = check(OPS.card.result, await main.call("card", { card: summary.card }));
    assert.equal(
      history.entries.filter((entry) => entry.fields["maintenanceBatch"] === "finalized").length,
      1,
    );
  } finally {
    await Promise.all(connections.map((session) => session.close()));
    await fleet.cardd.stop();
  }
});

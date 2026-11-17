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
    const x = workers[0];
    const y = workers[1];
    const tokenX = tokens[0];
    const tokenY = tokens[1];
    assert.ok(x && y && tokenX && tokenY);
    await x.close();
    const replacementX = await fleet.cardd.connect(tokenX, [], true, false, true, true);
    connections.push(replacementX);
    const b = await request("B");
    const pending = b.find((row) => row.session === a[1]?.session);
    assert.equal(pending?.id, a[1]?.id);
    assert.equal(pending?.batch, "B");
    assert.deepEqual(
      check(
        OPS["maintenance.status"].result,
        await fleet.main.call("maintenance.status", { batch: "A" }),
      ).map((row) => row.state),
      ["completed", "pending"],
    );
    await request("B");
    await y.close();
    connections.push(await fleet.cardd.connect(tokenY, [], true, false, true, true));
    const summaryA = await fleet.main.waitForEntry(
      (entry) => entry.fields["maintenanceBatch"] === "A",
      "A to summarize its original membership",
    );
    assert.match(summaryA.body, /2 reloaded and verified, 0 failed/);
    await replacementX.close();
    connections.push(await fleet.cardd.connect(tokenX, [], true, false, true, true));
    await fleet.main.waitForEntry(
      (entry) => entry.fields["maintenanceBatch"] === "B",
      "B to summarize its verified membership",
    );
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
    const entries = (
      await Promise.all(
        cards.map(
          async (card) =>
            check(OPS.card.result, await main.call("card", { card: card.id })).entries,
        ),
      )
    ).flat();
    for (const batch of ["A", "B"]) {
      assert.equal(entries.filter((entry) => entry.fields["maintenanceBatch"] === batch).length, 1);
    }
  } finally {
    await Promise.all(connections.map((session) => session.close()));
    await fleet.cardd.stop();
  }
});

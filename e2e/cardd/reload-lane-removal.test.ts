import assert from "node:assert/strict";
import { test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { begin, newCard, startFleet } from "../support/fleet.ts";

test("removing the lane of the last pending reload settles it as removed and main hears one summary, never a second", async () => {
  const fleet = await startFleet();
  const connections = [fleet.main];
  try {
    const card = await newCard(fleet.main, "verified worker");
    const token = await begin(fleet.main, card);
    const worker = await fleet.cardd.connect(token, [], true, false, true);
    connections.push(worker);
    const idle = fleet.cardd.addLane("idle", "main", "/homes/idle");
    const mate = await fleet.cardd.connect(idle, [], true, false, true);
    await mate.close();
    const rows = check(
      OPS["maintenance.request"].result,
      await fleet.main.call("maintenance.request", { batch: "removal", kind: "reload" }),
    );
    assert.deepEqual(rows.map((row) => [row.session, row.state]).sort(), [
      ["c-1-a1", "pending"],
      ["idle", "pending"],
    ]);
    await worker.close();
    connections.push(await fleet.cardd.connect(token, [], true, false, true, true));
    const before = check(OPS.card.result, await fleet.main.call("card", { card: card.id }));
    assert.equal(
      before.entries.filter((e) => e.fields["maintenanceBatch"] === "removal").length,
      0,
    );

    const removed = fleet.cardd.admin("lane", "remove", "idle");
    assert.equal(removed.status, 0, removed.stderr);

    await fleet.main.close();
    const main = await fleet.cardd.connect(fleet.mainToken);
    connections.push(main);
    const summary = await main.waitForEntry(
      (entry) => entry.fields["maintenanceBatch"] === "removal",
      "the one summary after the lane was removed",
    );
    assert.match(
      summary.body,
      /^Reload batch removal finished: 1 reloaded and verified, 0 failed, 1 removed with their lane; 0 pending\./,
    );
    assert.equal(summary.card, card.id);

    await main.call("maintenance.request", { batch: "removal", kind: "reload" });
    await main.call("maintenance.status", { batch: "removal" });
    const again = await fleet.cardd.connect(fleet.mainToken, [summary.id]);
    connections.push(again);
    const history = check(OPS.card.result, await again.call("card", { card: card.id }));
    assert.equal(
      history.entries.filter((e) => e.fields["maintenanceBatch"] === "removal").length,
      1,
    );
    assert.equal(
      history.entries.filter(
        (e) => e.fields["maintenance"] === rows[0]?.id && e.fields["state"] === "completed",
      ).length,
      1,
    );
    assert.equal(
      again.entries.filter((push) => push.entry.fields["maintenanceBatch"] === "removal").length,
      0,
    );
  } finally {
    await Promise.all(connections.map((session) => session.close().catch(() => undefined)));
    await fleet.cardd.stop();
  }
});

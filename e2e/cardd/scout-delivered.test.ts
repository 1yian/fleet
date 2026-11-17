import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet();
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const delivered = {
  evidence: "Read /reports/inventory.md and relayed the inventory to main in chat.",
  disposition: "The request was an inventory only. No build or unresolved decision remains.",
};

for (const lane of ["main", "cleo"]) {
  test(`${lane} closes research read by the mate without inventing a build or drop`, async () => {
    const mate =
      lane === "main" ? fleet.main : await fleet.cardd.connect(fleet.cardd.addLane(lane, "main"));
    const scout = await newCard(mate, "Inventory the existing services", "scout");
    const next = { delivered };
    const args = { card: scout.id, next };
    await mate.call("close.begin", args);
    await mate.call("close.finish", {
      ...args,
      mode: "done",
      text: "Inventory delivered.",
      archives: [],
      left: [],
    });
    assert.equal(await status(mate, scout), "done");
    const cleanup = (await fleet.cardd.thread(scout.id)).entries.findLast(
      (entry) => entry.kind === "cleanup",
    );
    assert.ok(cleanup);
    assert.deepEqual(cleanup.fields["next"], next);
    assert.equal(
      cleanup.body,
      `Delivered: ${delivered.evidence}\nDisposition: ${delivered.disposition}\nInventory delivered.`,
    );
  });
}

test("delivered requires evidence and disposition and cannot replace unfinished worker work or an open hold", async () => {
  const scout = await newCard(fleet.main, "Inventory the existing services", "scout");
  const worker = await fleet.cardd.connect(await begin(fleet.main, scout));
  const next = { delivered };
  await assert.rejects(
    fleet.main.call("close.begin", { card: scout.id, next }),
    /worker has not reported done/,
  );
  await worker.call("report", { status: "done", text: "Inventory delivered to the mate." });
  for (const invalid of [
    { evidence: " ", disposition: "Complete" },
    { evidence: "Read report" },
    { disposition: "Complete" },
  ]) {
    await assert.rejects(
      fleet.main.call("close.begin", { card: scout.id, next: { delivered: invalid } }),
      /invalid/,
    );
  }
  await assert.rejects(
    fleet.main.call("close.begin", { card: scout.id, next: { delivered, drop: "moot" } }),
    /exactly one/,
  );
  await fleet.main.call("hold", {
    card: scout.id,
    question: "Which recommendation should we build?",
  });
  await assert.rejects(fleet.main.call("close.begin", { card: scout.id, next }), /open hold/);
  await assert.rejects(
    fleet.main.call("close.finish", {
      card: scout.id,
      next,
      mode: "done",
      text: "Delivered",
      archives: [],
      left: [],
    }),
    /open hold/,
  );
  assert.equal(await status(fleet.main, scout), "needs-you");
});

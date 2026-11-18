import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Maintenance } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import type { Session } from "../support/cardd.ts";

let fleet: Fleet;
let connections: Session[];
beforeEach(async () => {
  fleet = await startFleet();
  connections = [fleet.main];
});
afterEach(async () => {
  await Promise.all(connections.map((session) => session.close().catch(() => undefined)));
  await fleet.cardd.stop();
});

async function verifiedWorkerAndIdleMates(
  batch: string,
  mates: readonly string[],
): Promise<{ rows: Maintenance[]; tokens: Map<string, string>; card: number }> {
  const card = await newCard(fleet.main, "verified worker");
  const token = await begin(fleet.main, card);
  const worker = await fleet.cardd.connect(token, [], true, false, true);
  connections.push(worker);
  const tokens = new Map<string, string>();
  for (const name of mates) {
    const mateToken = fleet.cardd.addLane(name, "main", `/homes/${name}`);
    tokens.set(name, mateToken);
    await (await fleet.cardd.connect(mateToken, [], true, false, true)).close();
  }
  const rows = check(
    OPS["maintenance.request"].result,
    await fleet.main.call("maintenance.request", { batch, kind: "reload" }),
  );
  const own = rows.find((row) => row.session === "c-1-a1");
  assert.ok(own);
  connections.push(await fleet.cardd.replace(worker, token, own.id));
  return { rows, tokens, card: card.id };
}

const remove = (lane: string): void => {
  const removed = fleet.cardd.admin("lane", "remove", lane);
  assert.equal(removed.status, 0, removed.stderr);
};

const summariesOf = async (session: Session, card: number, batch: string) =>
  check(OPS.card.result, await session.call("card", { card })).entries.filter(
    (entry) => entry.fields["maintenanceBatch"] === batch,
  );

test("removing the lane of the last pending reload settles it as removed and main hears one summary, never a second", async () => {
  const { rows } = await verifiedWorkerAndIdleMates("removal", ["idle"]);
  assert.deepEqual(rows.map((row) => [row.session, row.state]).sort(), [
    ["c-1-a1", "pending"],
    ["idle", "pending"],
  ]);
  assert.equal(
    fleet.main.entries.filter(({ entry }) => entry.fields["maintenanceBatch"] !== undefined).length,
    0,
  );

  remove("idle");

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
  assert.match(summary.body, /- host unknown: 0 reloaded and verified, 0 failed, 1 removed/);

  await main.call("maintenance.request", { batch: "removal", kind: "reload" });
  await main.call("maintenance.status", { batch: "removal" });
  const again = await fleet.cardd.connect(fleet.mainToken, [summary.id]);
  connections.push(again);
  assert.equal((await summariesOf(again, summary.card, "removal")).length, 1);
  assert.equal(
    again.entries.filter((push) => push.entry.fields["maintenanceBatch"] === "removal").length,
    0,
  );
});

test("each removed lane stays counted in its batch until the last open request settles", async () => {
  await verifiedWorkerAndIdleMates("both-removed", ["idle-a", "idle-b"]);
  remove("idle-a");
  await fleet.main.close();
  const main = await fleet.cardd.connect(fleet.mainToken);
  connections.push(main);
  assert.equal(
    main.entries.filter((push) => push.entry.fields["maintenanceBatch"] !== undefined).length,
    0,
  );
  remove("idle-b");
  await main.close();
  const next = await fleet.cardd.connect(fleet.mainToken);
  connections.push(next);
  const summary = await next.waitForEntry(
    (entry) => entry.fields["maintenanceBatch"] === "both-removed",
    "the summary that counts both removals",
  );
  assert.match(
    summary.body,
    /1 reloaded and verified, 0 failed, 2 removed with their lane; 0 pending/,
  );
  assert.equal((await summariesOf(next, summary.card, "both-removed")).length, 1);
});

test("a removal before another target verifies is counted next to that verification", async () => {
  const { rows, tokens } = await verifiedWorkerAndIdleMates("removed-then-verified", [
    "gone",
    "stays",
  ]);
  remove("gone");
  const token = tokens.get("stays");
  const request = rows.find((row) => row.session === "stays");
  assert.ok(token && request);
  const mate = await fleet.cardd.connect(token, [], true, false, true);
  connections.push(mate);
  connections.push(await fleet.cardd.replace(mate, token, request.id));
  const summary = await fleet.main.waitForEntry(
    (entry) => entry.fields["maintenanceBatch"] === "removed-then-verified",
    "the summary with the earlier removal",
  );
  assert.match(
    summary.body,
    /2 reloaded and verified, 0 failed, 1 removed with their lane; 0 pending/,
  );
  assert.equal((await summariesOf(fleet.main, summary.card, "removed-then-verified")).length, 1);
});

test("closing the card of a pending reload settles it as failed so the batch still summarizes", async () => {
  const verified = await newCard(fleet.main, "verified worker");
  const closing = await newCard(fleet.main, "closing worker");
  const verifiedToken = await begin(fleet.main, verified);
  const worker = await fleet.cardd.connect(verifiedToken, [], true, false, true);
  connections.push(
    worker,
    await fleet.cardd.connect(await begin(fleet.main, closing), [], true, false, true),
  );
  const rows = check(
    OPS["maintenance.request"].result,
    await fleet.main.call("maintenance.request", { batch: "closed", kind: "reload" }),
  );
  const own = rows.find((row) => row.session === `c-${String(verified.id)}-a1`);
  assert.ok(own);
  connections.push(await fleet.cardd.replace(worker, verifiedToken, own.id));
  assert.equal(
    fleet.main.entries.filter(({ entry }) => entry.fields["maintenanceBatch"] !== undefined).length,
    0,
  );
  await fleet.main.call("close.finish", {
    card: closing.id,
    mode: "dropped",
    text: "not needed",
    archives: [],
    left: [],
  });
  const summary = await fleet.main.waitForEntry(
    (entry) => entry.fields["maintenanceBatch"] === "closed",
    "the summary after the card closed",
  );
  assert.match(summary.body, /1 reloaded and verified, 1 failed; 0 pending/);
  const history = check(OPS.card.result, await fleet.main.call("card", { card: closing.id }));
  const failure = history.entries.find((entry) => entry.fields["state"] === "failed");
  assert.match(failure?.body ?? "", /its card was closed, so it was left as it is/);
});

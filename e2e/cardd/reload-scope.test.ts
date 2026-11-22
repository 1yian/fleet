import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import type { Session } from "../support/cardd.ts";
import { placeMate } from "../support/placement.ts";

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

async function worker(title: string, host: string): Promise<string> {
  const card = await newCard(fleet.main, title);
  const token = await begin(fleet.main, card, "the task", host);
  connections.push(await fleet.cardd.connect(token, [], true, false, true));
  return `c-${String(card.id)}-a1`;
}

async function mate(name: string, host?: string): Promise<void> {
  const token = fleet.cardd.addLane(name, "main", `/homes/${name}`);
  if (host !== undefined) placeMate(token, host);
  connections.push(await fleet.cardd.connect(token, [], true, false, true));
}

test("a scoped reload request enrolls only workers on the listed hosts and mates whose connection reports a listed host, and leaves every other session alone", async () => {
  const kept = await worker("kept worker", "maverick");
  const alsoKept = await worker("second kept worker", "maverick");
  await worker("excluded worker", "p620");
  await mate("here", "maverick");
  await mate("away", "p620");
  await mate("silent");

  const rows = check(
    OPS["maintenance.scoped"].result,
    await fleet.main.call("maintenance.scoped", { batch: "scoped", hosts: ["maverick"] }),
  );

  assert.deepEqual(rows.map((row) => row.session).sort(), [alsoKept, kept, "here"].sort());
  assert.ok(rows.every((row) => row.state === "pending"));
  const status = check(
    OPS["maintenance.status"].result,
    await fleet.main.call("maintenance.status", { batch: "scoped" }),
  );
  assert.deepEqual(status.map((row) => row.session).sort(), [alsoKept, kept, "here"].sort());
});

test("a mate that reconnects from another host is no longer enrolled by its old placement", async () => {
  const token = fleet.cardd.addLane("mover", "main", "/homes/mover");
  placeMate(token, "maverick");
  await (await fleet.cardd.connect(token, [], true, false, true)).close();
  placeMate(token, "p620");
  connections.push(await fleet.cardd.connect(token, [], true, false, true));

  const rows = check(
    OPS["maintenance.scoped"].result,
    await fleet.main.call("maintenance.scoped", { batch: "moved", hosts: ["maverick"] }),
  );

  assert.deepEqual(rows, []);
});

test("a scoped reload request with no host is refused and enrolls nothing", async () => {
  await worker("worker", "maverick");
  await mate("named", "maverick");

  await assert.rejects(
    fleet.main.call("maintenance.scoped", { batch: "empty", hosts: [] }),
    /invalid/,
  );
  const rows = check(
    OPS["maintenance.status"].result,
    await fleet.main.call("maintenance.status", { batch: "empty" }),
  );
  assert.deepEqual(rows, []);
});

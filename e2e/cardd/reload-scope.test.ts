import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
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

async function worker(title: string, host: string): Promise<string> {
  const card = await newCard(fleet.main, title);
  const token = await begin(fleet.main, card, "the task", host);
  connections.push(await fleet.cardd.connect(token, [], true, false, true));
  return `c-${String(card.id)}-a1`;
}

async function mate(name: string): Promise<void> {
  const token = fleet.cardd.addLane(name, "main", `/homes/${name}`);
  connections.push(await fleet.cardd.connect(token, [], true, false, true));
}

test("a scoped reload request enrolls only workers on the listed hosts and the named mates, and leaves every other session alone", async () => {
  const kept = await worker("kept worker", "maverick");
  const alsoKept = await worker("second kept worker", "maverick");
  await worker("excluded worker", "p620");
  await mate("named");
  await mate("unnamed");

  const rows = check(
    OPS["maintenance.scoped"].result,
    await fleet.main.call("maintenance.scoped", {
      batch: "scoped",
      kind: "reload",
      hosts: ["maverick"],
      mates: ["named"],
    }),
  );

  assert.deepEqual(rows.map((row) => row.session).sort(), [alsoKept, kept, "named"].sort());
  assert.ok(rows.every((row) => row.state === "pending"));
  const status = check(
    OPS["maintenance.status"].result,
    await fleet.main.call("maintenance.status", { batch: "scoped" }),
  );
  assert.deepEqual(status.map((row) => row.session).sort(), [alsoKept, kept, "named"].sort());
});

test("a scoped reload request with no host or a stow kind is refused and enrolls nothing", async () => {
  await worker("worker", "maverick");
  await mate("named");

  await assert.rejects(
    fleet.main.call("maintenance.scoped", {
      batch: "empty",
      kind: "reload",
      hosts: [],
      mates: ["named"],
    }),
    /invalid/,
  );
  await assert.rejects(
    fleet.main.call("maintenance.scoped", {
      batch: "stow",
      kind: "stow",
      hosts: ["maverick"],
      mates: [],
    }),
    /invalid/,
  );
  const rows = check(
    OPS["maintenance.status"].result,
    await fleet.main.call("maintenance.status", { batch: "empty" }),
  );
  assert.deepEqual(rows, []);
});

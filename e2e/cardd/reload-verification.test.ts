import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import type { Session } from "../support/cardd.ts";

let fleet: Fleet;
const sessions: Session[] = [];
beforeEach(async () => {
  fleet = await startFleet();
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await fleet.main.close();
  await fleet.cardd.stop();
});

async function worker(title: string): Promise<Session> {
  const token = await begin(fleet.main, await newCard(fleet.main, title));
  const session = await fleet.cardd.connect(token, [], true, false, true);
  sessions.push(session);
  return session;
}

test("only the owning session reads a reload receipt and only its requester can fail unverified reloads, leaving pending safe points alone", async () => {
  const first = await worker("reloading");
  const second = await worker("busy");
  const stranger = await fleet.cardd.connect(fleet.cardd.addLane("other", "main"));
  sessions.push(stranger);
  const rows = check(
    OPS["maintenance.request"].result,
    await fleet.main.call("maintenance.request", { batch: "bounded-reload", kind: "reload" }),
  );
  const request = rows.find((row) => row.session === "c-1-a1");
  assert.ok(request);
  await first.call("maintenance.ack", {
    id: request.id,
    state: "reloading",
    detail: "starting replacement",
  });
  assert.equal(
    check(OPS["maintenance.read"].result, await first.call("maintenance.read", { id: request.id }))
      .state,
    "reloading",
  );
  await assert.rejects(second.call("maintenance.read", { id: request.id }), /not yours/);
  await assert.rejects(
    stranger.call("maintenance.status", { batch: "bounded-reload", failUnverified: true }),
    /only the requester/,
  );
  const ended = check(
    OPS["maintenance.status"].result,
    await fleet.main.call("maintenance.status", { batch: "bounded-reload", failUnverified: true }),
  );
  assert.equal(ended.find((row) => row.id === request.id)?.state, "failed");
  assert.equal(ended.find((row) => row.session === "c-2-a1")?.state, "pending");
  const late = check(
    OPS["maintenance.ack"].result,
    await first.call("maintenance.ack", {
      id: request.id,
      state: "failed",
      detail: "late helper error",
    }),
  );
  assert.equal(late.detail, "no replacement hello before the update verification deadline");
});

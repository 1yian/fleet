import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Maintenance } from "@fleet/protocol";
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

async function assertLateReceipt(
  token: string,
  request: Maintenance,
  mixed: boolean,
): Promise<void> {
  const owner = await fleet.cardd.connect(token, [], true, false, true, true);
  sessions.push(owner);
  await owner.call("maintenance.ack", {
    id: request.id,
    state: "failed",
    detail: "duplicate late helper evidence",
  });
  await fleet.main.call("maintenance.request", { batch: "aggregate", kind: "reload" });
  await fleet.main.call("maintenance.status", { batch: "aggregate" });
  const state = check(
    OPS["maintenance.read"].result,
    await owner.call("maintenance.read", { id: request.id }),
  );
  assert.equal(state.state, mixed ? "failed" : "completed");
  assert.notEqual(state.detail, "duplicate late helper evidence");
  assert.equal(
    fleet.main.entries.filter(({ entry }) => entry.fields["maintenanceBatch"] === "aggregate")
      .length,
    1,
  );
  assert.equal(
    fleet.main.entries.filter(
      ({ entry }) =>
        typeof entry.fields["maintenance"] === "number" && entry.fields["state"] === "completed",
    ).length,
    0,
  );
}

function assertSummary(body: string, mixed: boolean): void {
  assert.ok(
    body.includes(`${mixed ? "1 reloaded and verified, 1" : "2 reloaded and verified, 0"} failed`),
  );
  assert.ok(body.includes("maverick: 1 reloaded and verified, 0 failed"));
  assert.ok(
    body.includes(
      `p620: ${mixed ? "0 reloaded and verified, 1" : "1 reloaded and verified, 0"} failed`,
    ),
  );
}

for (const mixed of [false, true]) {
  test(`reload notifications aggregate ${mixed ? "mixed" : "successful"} multi-host batches without losing receipts or accepting late results`, async () => {
    const workers = [];
    for (const host of ["maverick", "p620"]) {
      const card = await newCard(fleet.main, `reload on ${host}`);
      const token = await begin(fleet.main, card, "reload", host);
      const session = await fleet.cardd.connect(token, [], true, false, true);
      sessions.push(session);
      workers.push({ card, token, session });
    }
    const rows = check(
      OPS["maintenance.request"].result,
      await fleet.main.call("maintenance.request", { batch: "aggregate", kind: "reload" }),
    );
    const requestOf = (session: string): Maintenance => {
      const row = rows.find((each) => each.session === session);
      assert.ok(row);
      return row;
    };
    for (const item of workers) {
      const row = requestOf(`c-${String(item.card.id)}-a1`);
      await item.session.call("maintenance.ack", {
        id: row.id,
        state: "reloading",
        detail: "helper submitted replacement command",
      });
    }
    const first = workers[0];
    const second = workers[1];
    assert.ok(first && second);
    await first.session.close();
    const replacement = await fleet.cardd.connect(first.token, [], true, false, true, true);
    sessions.push(replacement);
    const read = async (item: typeof first) =>
      check(
        OPS["maintenance.read"].result,
        await (item === first ? replacement : item.session).call("maintenance.read", {
          id: requestOf(`c-${String(item.card.id)}-a1`).id,
        }),
      );
    assert.equal((await read(first)).state, "completed");
    assert.equal((await read(second)).state, "reloading");
    assert.equal(
      fleet.main.entries.filter(({ entry }) => entry.author === "maintenance").length,
      0,
    );
    const secondRequest = requestOf(`c-${String(second.card.id)}-a1`);
    if (mixed) {
      await second.session.close();
      await fleet.main.call("maintenance.status", { batch: "aggregate", failUnverified: true });
      const failure = await fleet.main.waitForEntry(
        (entry) => entry.fields["maintenance"] === secondRequest.id,
        "the individual failure",
      );
      assert.match(
        failure.body,
        new RegExp(
          `^${secondRequest.session} \\(worker on p620\\): reload failed - no replacement hello before the update verification deadline \\[c-${String(second.card.id)}, host p620, process ${fleet.cardd.processOf(second.token)}\\]$`,
        ),
      );
      assert.equal(failure.card, second.card.id);
    } else {
      await second.session.close();
      sessions.push(await fleet.cardd.connect(second.token, [], true, false, true, true));
    }
    const summary = await fleet.main.waitForEntry(
      (entry) => entry.fields["maintenanceBatch"] === "aggregate",
      "one batch summary",
    );
    assertSummary(summary.body, mixed);
    await assertLateReceipt(second.token, secondRequest, mixed);
    for (const item of workers) {
      const history = check(
        OPS.card.result,
        await fleet.main.call("card", { card: item.card.id }),
      ).entries;
      const receipts = history.filter(
        (entry) => entry.fields["maintenance"] === requestOf(`c-${String(item.card.id)}-a1`).id,
      );
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0]?.fields["state"], item === second && mixed ? "failed" : "completed");
    }
  });
}

test("a hello retried by the same runtime is not a verified reload", async () => {
  const token = await begin(fleet.main, await newCard(fleet.main, "welcome lost"));
  const first = await fleet.cardd.connect(token, [], true, false, true, true);
  sessions.push(first);
  const [row] = check(
    OPS["maintenance.request"].result,
    await fleet.main.call("maintenance.request", { batch: "retry", kind: "reload" }),
  );
  assert.ok(row);
  await first.close();
  const retried = await fleet.cardd.connect(token, [], true, false, true, true);
  sessions.push(retried);
  const read = async (session: Session) =>
    check(OPS["maintenance.read"].result, await session.call("maintenance.read", { id: row.id }))
      .state;
  assert.equal(await read(retried), "pending");
  sessions.push(await fleet.cardd.replace(retried, token, row.id));
  const summary = await fleet.main.waitForEntry(
    (entry) => entry.fields["maintenanceBatch"] === "retry",
    "the summary after the real replacement",
  );
  assert.match(summary.body, /1 reloaded and verified, 0 failed/);
});

test("immediate failures name the card, host and process in the rows main reads, and mark unknowns as unknown", async () => {
  const card = await newCard(fleet.main, "old code");
  const token = await begin(fleet.main, card, "reload", "maverick");
  sessions.push(await fleet.cardd.connect(token));
  const mateToken = fleet.cardd.addLane("old-mate", "main");
  sessions.push(await fleet.cardd.connect(mateToken));
  fleet.cardd.addLane("never-up", "main");
  const rows = check(
    OPS["maintenance.request"].result,
    await fleet.main.call("maintenance.request", { batch: "immediate", kind: "reload" }),
  );
  const detail = (session: string): string =>
    rows.find((row) => row.session === session)?.detail ?? "";
  assert.deepEqual(
    rows.map((row) => row.state),
    ["failed", "failed", "failed"],
  );
  assert.match(
    detail(`c-${String(card.id)}-a1`),
    new RegExp(
      `^runs code from before safe reloads, so it was left running: restart it by hand \\[c-${String(card.id)}, host maverick, process ${fleet.cardd.processOf(token)}\\]$`,
    ),
  );
  assert.match(
    detail("old-mate"),
    new RegExp(
      `^runs code from .* \\[c-\\d+, host unknown, process ${fleet.cardd.processOf(mateToken)}\\]$`,
    ),
  );
  assert.match(detail("never-up"), /^not connected .* \[c-\d+, host unknown, process unknown\]$/);
  assert.deepEqual(
    check(
      OPS["maintenance.status"].result,
      await fleet.main.call("maintenance.status", { batch: "immediate" }),
    ),
    rows,
  );
});

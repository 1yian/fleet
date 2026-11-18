import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Maintenance } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Cardd, type Session } from "../support/cardd.ts";

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
          `^${secondRequest.session} \\(worker on p620\\): reload failed - no replacement hello before the update verification deadline \\[c-${String(second.card.id)}, host p620, process ${second.session.runtime}\\]$`,
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

test("a hello retried by the runtime that held the request is never a verified reload, before or after its acknowledgement", async () => {
  const token = await begin(fleet.main, await newCard(fleet.main, "welcome lost"));
  const first = await fleet.cardd.connect(token, [], true, false, true, true);
  sessions.push(first);
  const [row] = check(
    OPS["maintenance.request"].result,
    await fleet.main.call("maintenance.request", { batch: "retry", kind: "reload" }),
  );
  assert.ok(row);
  const stateOf = async (session: Session) =>
    check(OPS["maintenance.read"].result, await session.call("maintenance.read", { id: row.id }))
      .state;
  await first.close();
  const retried = await fleet.cardd.connect(token, [], true, false, true, true, first.runtime);
  sessions.push(retried);
  assert.equal(await stateOf(retried), "pending");
  await retried.call("maintenance.ack", { id: row.id, state: "reloading", detail: "reloading" });
  await retried.close();
  const again = await fleet.cardd.connect(token, [], true, false, true, true, first.runtime);
  sessions.push(again);
  assert.equal(await stateOf(again), "reloading");
  assert.equal(fleet.cardd.summaryCount(), 0);
  sessions.push(await fleet.cardd.replace(again, token, row.id));
  const summary = await fleet.main.waitForEntry(
    (entry) => entry.fields["maintenanceBatch"] === "retry",
    "the summary after the real replacement",
  );
  assert.match(summary.body, /1 reloaded and verified, 0 failed/);
});

test("a failure after a reconnect names the runtime that acknowledged, only in what main is told", async () => {
  const card = await newCard(fleet.main, "reconnected before the safe point");
  const token = await begin(fleet.main, card, "reload", "maverick");
  const enrolled = await fleet.cardd.connect(token, [], true, false, true);
  await enrolled.close();
  const [row] = check(
    OPS["maintenance.request"].result,
    await fleet.main.call("maintenance.request", { batch: "acting", kind: "reload" }),
  );
  assert.ok(row);
  assert.equal(row.state, "pending");
  const acting = await fleet.cardd.connect(token, [], true, false, true);
  sessions.push(acting);
  assert.notEqual(acting.runtime, enrolled.runtime);
  await acting.call("maintenance.ack", { id: row.id, state: "reloading", detail: "reloading" });
  const failed = await fleet.cardd.post(token, "maintenance.ack", {
    id: row.id,
    state: "failed",
    detail: "helper could not start",
  });
  assert.equal(failed.status, 200);
  const told = await fleet.main.waitForEntry(
    (entry) => entry.fields["maintenance"] === row.id && entry.fields["state"] === "failed",
    "the individual failure",
  );
  assert.equal(
    told.body,
    `${row.session} (worker on maverick): reload failed - helper could not start [c-${String(card.id)}, host maverick, process ${acting.runtime}]`,
  );
  const stored = check(OPS.card.result, await fleet.main.call("card", { card: card.id })).entries;
  const onCard = JSON.stringify(stored.filter((entry) => entry.fields["maintenance"] === row.id));
  assert.ok(onCard.includes("helper could not start"));
  for (const runtime of [acting.runtime, enrolled.runtime])
    assert.equal(onCard.includes(runtime), false);
  assert.equal(JSON.stringify(await fleet.cardd.thread(card.id)).includes(acting.runtime), false);
});

test("a pending reload whose target reconnects on code without safe reloads fails, so the batch still summarizes", async () => {
  const verified = await newCard(fleet.main, "verifies");
  const old = await newCard(fleet.main, "old code");
  const verifiedToken = await begin(fleet.main, verified);
  const oldToken = await begin(fleet.main, old);
  const worker = await fleet.cardd.connect(verifiedToken, [], true, false, true);
  sessions.push(worker);
  await (await fleet.cardd.connect(oldToken, [], true, false, true)).close();
  const rows = check(
    OPS["maintenance.request"].result,
    await fleet.main.call("maintenance.request", { batch: "unsupported", kind: "reload" }),
  );
  const own = rows.find((row) => row.session === `c-${String(verified.id)}-a1`);
  assert.ok(own);
  sessions.push(await fleet.cardd.replace(worker, verifiedToken, own.id));
  assert.equal(fleet.cardd.summaryCount(), 0);
  sessions.push(await fleet.cardd.connect(oldToken, [], true, false, false));
  const summary = await fleet.main.waitForEntry(
    (entry) => entry.fields["maintenanceBatch"] === "unsupported",
    "the summary after the unsupported reconnect",
  );
  assert.match(summary.body, /1 reloaded and verified, 1 failed; 0 pending/);
  const failure = await fleet.main.waitForEntry(
    (entry) => entry.card === old.id && entry.fields["state"] === "failed",
    "the unsupported target's failure",
  );
  assert.match(failure.body, /runs code from before safe reloads/);
});

test("a request that was outstanding before batches existed still notifies main individually, with no summary", async () => {
  const card = await newCard(fleet.main, "outstanding at the upgrade");
  const token = await begin(fleet.main, card);
  const worker = await fleet.cardd.connect(token, [], true, false, true);
  const db = new DatabaseSync(fleet.cardd.db, { timeout: 5000 });
  const inserted = db
    .prepare(
      `INSERT INTO maintenance (batch, requester, session, kind, state, detail, updated_at)
       VALUES ('legacy', 'main', ?, 'reload', 'reloading', 'reloading', ?)`,
    )
    .run(`c-${String(card.id)}-a1`, Date.now());
  db.close();
  await worker.close();
  sessions.push(await fleet.cardd.connect(token, [], true, false, true, true));
  const id = Number(inserted.lastInsertRowid);
  const told = await fleet.main.waitForEntry(
    (entry) => entry.fields["maintenance"] === id && entry.fields["state"] === "completed",
    "the individual completed notice",
  );
  assert.match(told.body, /reload completed - reconnected on a new process/);
  assert.equal(fleet.cardd.summaryCount(), 0);
});

test("the batch aggregate and status stay with the registered root, while individual receipts keep their audience", async () => {
  const other = await fleet.cardd.connect(fleet.cardd.addLane("other", "main"));
  sessions.push(other);
  const own = await newCard(other, "child work");
  const ownToken = await begin(other, own);
  const mine = await newCard(fleet.main, "main work");
  const mineToken = await begin(fleet.main, mine);
  const child = await fleet.cardd.connect(ownToken, [], true, false, true);
  const root = await fleet.cardd.connect(mineToken, [], true, false, true);
  sessions.push(child, root);
  const rows = check(
    OPS["maintenance.request"].result,
    await fleet.main.call("maintenance.request", { batch: "private", kind: "reload" }),
  );
  const childRow = rows.find((row) => row.session === `c-${String(own.id)}-a1`);
  const rootRow = rows.find((row) => row.session === `c-${String(mine.id)}-a1`);
  assert.ok(childRow && rootRow);
  sessions.push(await fleet.cardd.replace(child, ownToken, childRow.id));
  await root.call("maintenance.ack", { id: rootRow.id, state: "reloading", detail: "reloading" });
  await fleet.cardd.post(mineToken, "maintenance.ack", {
    id: rootRow.id,
    state: "failed",
    detail: "helper could not start",
  });
  const summary = await fleet.main.waitForEntry(
    (entry) => entry.fields["maintenanceBatch"] === "private",
    "the aggregate",
  );
  assert.equal(summary.card, own.id);
  const told = await fleet.main.waitForEntry(
    (entry) => entry.fields["maintenance"] === rootRow.id && entry.fields["state"] === "failed",
    "the individual failure",
  );
  assert.ok(told.body.endsWith(`process ${root.runtime}]`));
  const read = async (reader: Session, card: number) =>
    check(OPS.card.result, await reader.call("card", { card })).entries;
  const aggregates = (entries: readonly { fields: Record<string, unknown> }[]) =>
    entries.filter((entry) => entry.fields["maintenanceBatch"] !== undefined).length;
  const receipts = (entries: readonly { fields: Record<string, unknown> }[]) =>
    entries.filter((entry) => entry.fields["maintenance"] === childRow.id).length;
  const forRoot = await read(fleet.main, own.id);
  assert.equal(aggregates(forRoot), 1);
  assert.equal(receipts(forRoot), 1);
  const forChild = await read(other, own.id);
  assert.equal(aggregates(forChild), 0);
  assert.equal(receipts(forChild), 1);
  await assert.rejects(
    other.call("maintenance.status", { batch: "private" }),
    /only the requester/,
  );
  const everywhere = JSON.stringify([
    await fleet.cardd.board(),
    await fleet.cardd.thread(own.id),
    await fleet.cardd.thread(mine.id),
    forChild,
  ]);
  assert.equal(everywhere.includes("Reload batch private"), false);
  for (const runtime of [child.runtime, root.runtime])
    assert.equal(everywhere.includes(runtime), false);
  assert.ok(everywhere.includes(`c-${String(own.id)}-a1`));
});

test("only the registered root can request or read a batch, whatever lanes are named", async () => {
  const cardd = await Cardd.start();
  try {
    const root = await cardd.connect(cardd.addLane("captain"));
    const child = await cardd.connect(cardd.addLane("main", "captain"));
    sessions.push(root, child);
    await assert.rejects(
      child.call("maintenance.request", { batch: "b", kind: "reload" }),
      /only main can ask/,
    );
    await assert.rejects(child.call("maintenance.status", { batch: "b" }), /only the requester/);
    const asked = check(
      OPS["maintenance.request"].result,
      await root.call("maintenance.request", { batch: "b", kind: "reload" }),
    );
    assert.deepEqual(
      asked.map((row) => row.session),
      ["main"],
    );
    assert.deepEqual(
      check(
        OPS["maintenance.status"].result,
        await root.call("maintenance.status", { batch: "b" }),
      ),
      asked,
    );
  } finally {
    await cardd.stop();
  }
});

test("immediate failures name the card, host and process in the rows main reads, and mark unknowns as unknown", async () => {
  const card = await newCard(fleet.main, "old code");
  const token = await begin(fleet.main, card, "reload", "maverick");
  const oldWorker = await fleet.cardd.connect(token);
  const mateToken = fleet.cardd.addLane("old-mate", "main");
  const oldMate = await fleet.cardd.connect(mateToken);
  sessions.push(oldWorker, oldMate);
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
  assert.equal(
    detail(`c-${String(card.id)}-a1`),
    `runs code from before safe reloads, so it was left running: restart it by hand [c-${String(card.id)}, host maverick, process ${oldWorker.runtime}]`,
  );
  assert.match(
    detail("old-mate"),
    new RegExp(`^runs code from .* \\[c-\\d+, host unknown, process ${oldMate.runtime}\\]$`),
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

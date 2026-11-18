import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
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
  const enrolled = await fleet.cardd.connect(oldToken, [], true, false, true);
  await enrolled.close();
  const rows = check(
    OPS["maintenance.request"].result,
    await fleet.main.call("maintenance.request", { batch: "unsupported", kind: "reload" }),
  );
  const own = rows.find((row) => row.session === `c-${String(verified.id)}-a1`);
  assert.ok(own);
  sessions.push(await fleet.cardd.replace(worker, verifiedToken, own.id));
  assert.equal(fleet.cardd.summaryCount(), 0);
  const refusing = await fleet.cardd.connect(oldToken, [], true, false, false);
  sessions.push(refusing);
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
  assert.ok(failure.body.endsWith(`process ${refusing.runtime}]`));
  assert.equal(failure.body.includes(enrolled.runtime), false);
});

test("a refusal as the first acknowledgement names the refusing runtime, not the one enrolled", async () => {
  const card = await newCard(fleet.main, "refuses at the safe point");
  const token = await begin(fleet.main, card, "reload", "maverick");
  const enrolled = await fleet.cardd.connect(token, [], true, false, true);
  await enrolled.close();
  const [row] = check(
    OPS["maintenance.request"].result,
    await fleet.main.call("maintenance.request", { batch: "refusal", kind: "reload" }),
  );
  assert.ok(row);
  const refusing = await fleet.cardd.connect(token, [], true, false, true);
  sessions.push(refusing);
  await refusing.call("maintenance.ack", { id: row.id, state: "failed", detail: "not in herdr" });
  const told = await fleet.main.waitForEntry(
    (entry) => entry.fields["maintenance"] === row.id && entry.fields["state"] === "failed",
    "the refusal",
  );
  assert.ok(told.body.endsWith(`process ${refusing.runtime}]`));
  assert.equal(told.body.includes(enrolled.runtime), false);
});

test("a started hello still completes a stow, from any runtime", async () => {
  const token = fleet.cardd.addLane("stowed", "main");
  const first = await fleet.cardd.connect(token, [], true, false, true);
  const [row] = check(
    OPS["maintenance.request"].result,
    await fleet.main.call("maintenance.request", { batch: "stow-batch", kind: "stow" }),
  );
  assert.ok(row);
  await first.call("maintenance.ack", { id: row.id, state: "reloading", detail: "stowing" });
  await first.close();
  const again = await fleet.cardd.connect(token, [], true, false, true, true, first.runtime);
  sessions.push(again);
  const told = await fleet.main.waitForEntry(
    (entry) => entry.fields["maintenance"] === row.id && entry.fields["state"] === "completed",
    "the stow's completion",
  );
  assert.match(told.body, /stow completed/);
  assert.equal(fleet.cardd.summaryCount(), 0);
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

test("a request outstanding before batches existed keeps its individual notice when a later update also counts it", async () => {
  const card = await newCard(fleet.main, "outstanding across an update");
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
  await fleet.main.call("maintenance.request", { batch: "later", kind: "reload" });
  await worker.close();
  sessions.push(await fleet.cardd.connect(token, [], true, false, true, true));
  const id = Number(inserted.lastInsertRowid);
  await fleet.main.waitForEntry(
    (entry) => entry.fields["maintenance"] === id && entry.fields["state"] === "completed",
    "the individual completed notice",
  );
  const summary = await fleet.main.waitForEntry(
    (entry) => entry.fields["maintenanceBatch"] === "later",
    "the later batch's summary",
  );
  assert.match(summary.body, /1 reloaded and verified, 0 failed/);
  assert.equal(fleet.cardd.summaryCount(), 1);
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
  const refused = rows.find((row) => row.session === `c-${String(card.id)}-a1`);
  assert.ok(refused);
  const owned = check(
    OPS["maintenance.read"].result,
    await oldWorker.call("maintenance.read", { id: refused.id }),
  );
  assert.equal(
    owned.detail,
    "runs code from before safe reloads, so it was left running: restart it by hand",
  );
  const acked = check(
    OPS["maintenance.ack"].result,
    await oldWorker.call("maintenance.ack", { id: refused.id, state: "failed", detail: "late" }),
  );
  assert.equal(acked.detail.includes(oldWorker.runtime), false);
  assert.deepEqual(
    check(
      OPS["maintenance.status"].result,
      await fleet.main.call("maintenance.status", { batch: "immediate" }),
    ),
    rows,
  );
});

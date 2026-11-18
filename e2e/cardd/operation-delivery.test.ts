import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { newCard, startFleet, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet();
});
afterEach(async () => fleet.cardd.stop());

test("the CLI selects ops on one unstarted card, persists it across restart, and keeps the product default", async () => {
  const card = await newCard(fleet.main, "Run the approved operation");
  const changed = fleet.cardd.admin("card", "delivery", String(card.id), "ops");
  assert.equal(changed.status, 0);
  assert.match(changed.stdout, /delivery no-mistakes -> ops/);
  await fleet.cardd.restart();
  const main = await fleet.cardd.connect(fleet.mainToken);
  const begun = check(
    OPS["attempt.begin"].result,
    await main.call("attempt.begin", {
      card: card.id,
      host: "maverick",
      task: "Run it",
    }),
  );
  assert.equal(begun.delivery, "ops");
  const worker = await fleet.cardd.connect(begun.token);
  const [task] = await worker.waitForEntries(1);
  assert.equal(task?.body, "Run it\n\nDelivery: ops");
  const live = fleet.cardd.admin("card", "delivery", String(card.id), "direct-PR");
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /has a live worker/);
  const product = check(
    CardSchema,
    await main.call("card.new", {
      title: "Change the product",
      kind: "ship",
      project: "web",
    }),
  );
  assert.equal(product.delivery, "no-mistakes");
  const rejected = fleet.cardd.admin("project", "delivery", "web", "ops");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /ops is card-only/);
});

test("a card carrying a product PR refuses ops from the CLI, and a running one keeps its mode when dispatch asks for ops", async () => {
  const card = await newCard(fleet.main, "Change the product");
  const begun = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", { card: card.id, host: "maverick", task: "Build it" }),
  );
  const worker = await fleet.cardd.connect(begun.token);
  await worker.call("report", {
    status: "done",
    text: "PR ready",
    pr: "https://github.com/acme/web/pull/8",
  });
  const cli = fleet.cardd.admin("card", "delivery", String(card.id), "ops");
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /a card with a PR cannot change to ops/);
  await assert.rejects(
    fleet.main.call("attempt.begin", {
      card: card.id,
      host: "maverick",
      task: "Run it",
      delivery: "ops",
    }),
    /a running card keeps its delivery mode/,
  );
  const thread = await fleet.cardd.thread(card.id);
  assert.equal(thread.card.delivery, "no-mistakes");
  assert.equal(thread.card.pr, "https://github.com/acme/web/pull/8");
  const view = check(OPS.card.result, await fleet.main.call("card", { card: card.id }));
  assert.equal(view.attempts.length, 1);
});

async function operationCard(): Promise<{ card: number; worker: Session }> {
  const card = await newCard(fleet.main, "Run the approved operation");
  assert.equal(fleet.cardd.admin("card", "delivery", String(card.id), "ops").status, 0);
  const begun = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", { card: card.id, host: "maverick", task: "Run it" }),
  );
  return { card: card.id, worker: await fleet.cardd.connect(begun.token) };
}

const EVIDENCE = "/home/worker/.fleet/scratch/c-1/operation.md";

test("only the done report of an ops card carries evidence, and a done report must", async () => {
  const product = await newCard(fleet.main, "Change the product");
  const begun = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", { card: product.id, host: "maverick", task: "Build" }),
  );
  const productWorker = await fleet.cardd.connect(begun.token);
  await assert.rejects(
    productWorker.call("report", { status: "done", text: "ready", evidence: EVIDENCE }),
    /evidence is only for the done report of an ops card/,
  );
  const { card, worker } = await operationCard();
  await assert.rejects(
    worker.call("report", { status: "working", text: "going", evidence: EVIDENCE }),
    /evidence is only for the done report of an ops card/,
  );
  await assert.rejects(
    worker.call("report", { status: "done", text: "finished" }),
    /ops completion requires evidence/,
  );
  await assert.rejects(
    worker.call("report", { status: "done", text: "finished", evidence: "relative/report.md" }),
    /pattern/i,
  );
  await assert.rejects(
    worker.call("report", {
      status: "done",
      text: "finished",
      evidence: EVIDENCE,
      pr: "https://github.com/acme/web/pull/9",
    }),
    /ops work does not report a PR or merge/,
  );
  const thread = await fleet.cardd.thread(card);
  assert.equal(
    thread.entries.some((entry) => entry.fields["evidence"] !== undefined),
    false,
  );
});

test("an ops card closes Done only through the handoff it was given, with no clone refresh", async () => {
  const { card, worker } = await operationCard();
  const early = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card, landed: false }),
  );
  assert.equal(early.operation, undefined);
  await assert.rejects(
    fleet.main.call("close.begin", { card }),
    /the worker has not reported done/,
  );
  await worker.call("report", { status: "done", text: "finished", evidence: EVIDENCE });
  const plan = check(OPS["close.begin"].result, await fleet.main.call("close.begin", { card }));
  assert.equal(plan.mode, "done");
  assert.deepEqual(plan.refresh, []);
  assert.deepEqual(plan.operation, {
    evidence: EVIDENCE,
    session: `c-${String(card)}-a1`,
  });
});

test("a direct finish refuses Done for an ops card whose close archived or left an attempt", async () => {
  const { card, worker } = await operationCard();
  await worker.call("report", { status: "done", text: "finished", evidence: EVIDENCE });
  const finish = { card, mode: "done", text: "Done." };
  await assert.rejects(
    fleet.main.call("close.finish", { ...finish, archives: ["maverick:/a.tar.zst"], left: [] }),
    /archived or left unverified/,
  );
  await assert.rejects(
    fleet.main.call("close.finish", {
      ...finish,
      archives: [],
      left: [{ session: `c-${String(card)}-a1`, host: "maverick", reason: "unreachable" }],
    }),
    /archived or left unverified/,
  );
  assert.equal((await fleet.cardd.thread(card)).card.status, "with-mate");
});

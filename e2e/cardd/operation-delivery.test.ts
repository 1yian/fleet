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

const evidenceOf = (card: number): string =>
  `/home/worker/.fleet/scratch/c-${String(card)}/operation.md`;

async function operationCard(): Promise<{ card: number; worker: Session }> {
  const made = check(
    CardSchema,
    await fleet.main.call("card.new", {
      title: "Run the approved operation",
      kind: "ship",
      project: "web",
    }),
  );
  assert.equal(fleet.cardd.admin("card", "delivery", String(made.id), "ops").status, 0);
  const begun = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", { card: made.id, host: "maverick", task: "Run it" }),
  );
  return { card: made.id, worker: await fleet.cardd.connect(begun.token) };
}

test("only the done report of an ops card carries evidence from its own scratch folder", async () => {
  const product = await newCard(fleet.main, "Change the product");
  const begun = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", { card: product.id, host: "maverick", task: "Build" }),
  );
  const productWorker = await fleet.cardd.connect(begun.token);
  await assert.rejects(
    productWorker.call("report", {
      status: "done",
      text: "ready",
      evidence: evidenceOf(product.id),
    }),
    /evidence is only for the done report of an ops card/,
  );
  const { card, worker } = await operationCard();
  const evidence = evidenceOf(card);
  await assert.rejects(
    worker.call("report", { status: "working", text: "going", evidence }),
    /evidence is only for the done report of an ops card/,
  );
  await assert.rejects(
    worker.call("report", { status: "done", text: "finished" }),
    /ops completion requires evidence/,
  );
  for (const bad of [
    "relative/report.md",
    "/etc/passwd",
    evidenceOf(card + 1),
    evidence.replace("operation.md", "tmp/operation.md"),
    evidence.replace("operation.md", "../c-9/operation.md"),
  ]) {
    await assert.rejects(
      worker.call("report", { status: "done", text: "finished", evidence: bad }),
      /pattern|ops evidence must be a file in this card's/,
    );
  }
  await assert.rejects(
    worker.call("report", {
      status: "done",
      text: "finished",
      evidence,
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

test("the web thread and board summary carry no evidence field and no evidence path, even one named by an earlier report", async () => {
  const { card, worker } = await operationCard();
  const first = evidenceOf(card);
  const second = first.replace("operation.md", "second.md");
  await worker.call("report", {
    status: "needs-decision",
    text: `${second} holds my draft`,
    key: "draft",
  });
  await worker.call("report", { status: "done", text: `finished, see ${first}`, evidence: first });
  await fleet.main.call("comment", { card, text: "One more check." });
  await worker.call("report", {
    status: "done",
    text: `again, instead of ${first}, see ${second}`,
    evidence: second,
  });
  const thread = await fleet.cardd.thread(card);
  for (const entry of thread.entries) assert.equal(entry.fields["evidence"], undefined);
  assert.doesNotMatch(JSON.stringify(thread), /operation\.md|second\.md|scratch/);
  assert.doesNotMatch(
    JSON.stringify(await fleet.cardd.board()),
    /operation\.md|second\.md|scratch/,
  );
});

const NO_DONE = /c-\d+ did not land: the worker has not reported done\./;

const finishDone = (card: number): Promise<unknown> =>
  fleet.main.call("close.finish", {
    card,
    mode: "done",
    text: "Operation done.",
    archives: [],
    left: [],
  });

test("an ops card refuses a Done close until its worker's done report stands, and a steer takes that report back", async () => {
  const { card, worker } = await operationCard();
  const statusOf = async (): Promise<string> => (await fleet.cardd.thread(card)).card.status;
  await assert.rejects(fleet.main.call("close.begin", { card }), NO_DONE);
  await assert.rejects(finishDone(card), NO_DONE);
  await worker.call("report", { status: "working", text: "going" });
  await assert.rejects(fleet.main.call("close.begin", { card }), NO_DONE);
  assert.equal(await statusOf(), "working");

  await worker.call("report", {
    status: "done",
    text: "operation complete",
    evidence: evidenceOf(card),
  });
  const plan = check(OPS["close.begin"].result, await fleet.main.call("close.begin", { card }));
  assert.equal(plan.mode, "done");
  assert.equal(plan.land, false);
  assert.deepEqual(plan.refresh, []);
  assert.equal(plan.attempts.length, 1);

  await fleet.main.call("comment", { card, text: "One more check first." });
  await assert.rejects(fleet.main.call("close.begin", { card }), NO_DONE);
  await assert.rejects(finishDone(card), NO_DONE);
  assert.equal(await statusOf(), "working");

  await worker.call("report", {
    status: "done",
    text: "operation complete, again",
    evidence: evidenceOf(card),
  });
  assert.equal(await statusOf(), "with-mate");
  const closed = check(CardSchema, await finishDone(card));
  assert.equal(closed.status, "done");
  const thread = await fleet.cardd.thread(card);
  const cleanup = thread.entries.filter((entry) => entry.kind === "cleanup");
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0]?.fields["outcome"], "done");
  await assert.rejects(finishDone(card), /c-\d+ is already done/);
});

test("landed=false drops an ops card whether or not its worker reported done", async () => {
  const early = await operationCard();
  const plan = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: early.card, landed: false }),
  );
  assert.equal(plan.mode, "dropped");
  const dropped = check(
    CardSchema,
    await fleet.main.call("close.finish", {
      card: early.card,
      mode: "dropped",
      text: "Not approved.",
      archives: [],
      left: [],
    }),
  );
  assert.equal(dropped.status, "dropped");

  const late = await operationCard();
  await late.worker.call("report", {
    status: "done",
    text: "operation complete",
    evidence: evidenceOf(late.card),
  });
  const after = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: late.card, landed: false }),
  );
  assert.equal(after.mode, "dropped");
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS } from "@fleet/protocol";
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

test("a card carrying a product PR cannot change to ops through either CLI or dispatch", async () => {
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

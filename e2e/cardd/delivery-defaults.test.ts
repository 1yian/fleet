import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS, type Card } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { newCard, startFleet, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet();
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const registered = async (): Promise<string | undefined> =>
  check(OPS.projects.result, await fleet.main.call("projects", {})).find(
    (each) => each.name === "web",
  )?.delivery;

const dispatched = async (card: Card, mate: Session = fleet.main) => {
  const begun = check(
    OPS["attempt.begin"].result,
    await mate.call("attempt.begin", {
      card: card.id,
      host: "maverick",
      task: "go",
    }),
  );
  const worker = await fleet.cardd.connect(begun.token);
  const [task] = await worker.waitForEntries(1);
  await worker.close();
  return { delivery: begun.delivery, task: task?.body };
};

const deliveryOf = async (card: Card): Promise<unknown> =>
  (await fleet.cardd.thread(card.id)).card.delivery;

test("a project's default delivery changes, survives a cardd restart, and new cards take it", async () => {
  const result = fleet.cardd.admin("project", "delivery", "web", "direct-PR");
  assert.deepEqual([result.status, result.stdout], [0, "web: delivery direct-PR"]);
  assert.equal(await registered(), "direct-PR");

  await fleet.cardd.restart();
  const main = await fleet.cardd.connect(fleet.mainToken);
  const listed = check(OPS.projects.result, await main.call("projects", {}));
  assert.equal(listed[0]?.delivery, "direct-PR");

  const card = check(
    CardSchema,
    await main.call("card.new", { title: "Users see one scrollbar", kind: "ship", project: "web" }),
  );
  assert.equal(card.delivery, "direct-PR");
  assert.deepEqual(await dispatched(card, main), {
    delivery: "direct-PR",
    task: "go\n\nDelivery: direct-PR",
  });
});

test("a card created before the default changed keeps its recorded delivery", async () => {
  const before = await newCard(fleet.main, "Users see one scrollbar");
  fleet.cardd.admin("project", "delivery", "web", "direct-PR");

  assert.equal(await deliveryOf(before), "no-mistakes");
  assert.deepEqual(await dispatched(before), {
    delivery: "no-mistakes",
    task: "go\n\nDelivery: no-mistakes",
  });
  const after = await newCard(fleet.main, "Users see two scrollbars");
  assert.equal(after.delivery, "direct-PR");
});

test("an unknown delivery mode or project is refused and changes nothing", async () => {
  const bad = fleet.cardd.admin("project", "delivery", "web", "yolo-deploy");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /yolo-deploy must be one of no-mistakes, direct-PR, local-only/);

  const stranger = fleet.cardd.admin("project", "delivery", "nope", "direct-PR");
  assert.equal(stranger.status, 1);
  assert.match(stranger.stderr, /project nope is not in the registry/);

  const missing = fleet.cardd.admin("project", "delivery", "web");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /usage: cardd/);
  assert.equal(await registered(), "no-mistakes");
});

test("an open card with no worker takes a new delivery, which its first worker is told", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");

  const result = fleet.cardd.admin("card", "delivery", String(card.id), "direct-PR");
  assert.deepEqual(
    [result.status, result.stdout],
    [0, `c-${String(card.id)}: delivery no-mistakes -> direct-PR`],
  );
  assert.equal(await deliveryOf(card), "direct-PR");
  assert.equal(await registered(), "no-mistakes");
  assert.deepEqual(await dispatched(card), {
    delivery: "direct-PR",
    task: "go\n\nDelivery: direct-PR",
  });

  const thread = await fleet.cardd.thread(card.id);
  const note = thread.entries.find((entry) => entry.kind === "note");
  assert.equal(note?.body, "delivery changed from no-mistakes to direct-PR");
});

test("changing a card to the delivery it already has changes nothing", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const before = (await fleet.cardd.thread(card.id)).entries.length;

  const result = fleet.cardd.admin("card", "delivery", String(card.id), "no-mistakes");
  assert.deepEqual(
    [result.status, result.stdout],
    [0, `c-${String(card.id)}: delivery is already no-mistakes`],
  );
  assert.equal((await fleet.cardd.thread(card.id)).entries.length, before);
});

test("a card with a live worker keeps its delivery, so the worker's assignment is never stale", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await dispatched(card);

  const refused = fleet.cardd.admin("card", "delivery", String(card.id), "direct-PR");
  assert.equal(refused.status, 1);
  assert.match(
    refused.stderr,
    new RegExp(
      `c-${String(card.id)} has a live worker c-${String(card.id)}-a1 running with Delivery: no-mistakes`,
    ),
  );
  assert.match(refused.stderr, /create new work with dispatch for a different mode/);
  assert.equal(await deliveryOf(card), "no-mistakes");
  await assert.rejects(
    fleet.main.call("attempt.begin", {
      card: card.id,
      host: "maverick",
      task: "go",
      delivery: "direct-PR",
    }),
    /a running card keeps its delivery mode/,
  );

  assert.equal(await deliveryOf(card), "no-mistakes");
});

test("a card that is not an open ship card, or does not exist, is refused", async () => {
  const scout = check(
    CardSchema,
    await fleet.main.call("card.new", { title: "Look into it", kind: "scout", project: "web" }),
  );
  const refusedScout = fleet.cardd.admin("card", "delivery", String(scout.id), "direct-PR");
  assert.equal(refusedScout.status, 1);
  assert.match(
    refusedScout.stderr,
    new RegExp(`c-${String(scout.id)} is a scout card: only a ship card has a delivery mode`),
  );

  const done = await newCard(fleet.main, "Users see one scrollbar");
  await fleet.main.call("close.begin", { card: done.id, landed: false });
  await fleet.main.call("close.finish", {
    card: done.id,
    mode: "dropped",
    text: "not needed",
    archives: [],
    left: [],
  });
  const refusedClosed = fleet.cardd.admin("card", "delivery", String(done.id), "direct-PR");
  assert.equal(refusedClosed.status, 1);
  assert.match(refusedClosed.stderr, /card is dropped/);
  assert.equal(await deliveryOf(done), "no-mistakes");

  const unknown = fleet.cardd.admin("card", "delivery", "9999", "direct-PR");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no card c-9999/);

  const wrongMode = fleet.cardd.admin("card", "delivery", String(done.id), "someday");
  assert.equal(wrongMode.status, 1);
  assert.match(wrongMode.stderr, /someday must be one of no-mistakes, direct-PR, local-only/);

  const notANumber = fleet.cardd.admin("card", "delivery", "c-1", "direct-PR");
  assert.equal(notANumber.status, 1);
  assert.match(notANumber.stderr, /card c-1 must be a card number/);
});

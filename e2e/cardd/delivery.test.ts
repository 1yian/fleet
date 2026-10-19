// Delivery records and recovery (spec section 9.4), against a real cardd.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Card } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "./fleet.ts";

let fleet: Fleet;
let card: Card;
let token: string;
beforeEach(async () => {
  fleet = await startFleet();
  card = await newCard(fleet.main, "Users see one scrollbar");
  token = await begin(fleet.main, card);
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const comment = (text: string, now = false): Promise<unknown> =>
  fleet.main.call("comment", { card: card.id, text, now });

test("a comment reaches the worker as a follow-up, and now makes it a steer", async () => {
  const worker = await fleet.cardd.connect(token);
  await comment("use the v2 endpoint");
  await comment("stop, the API is down", true);
  await worker.waitForEntries(2);

  assert.deepEqual(
    worker.entries.map(({ entry, mode }) => [entry.author, entry.body, mode]),
    [
      ["mate:main", "use the v2 endpoint", "followUp"],
      ["mate:main", "stop, the API is down", "steer"],
    ],
  );
});

test("an entry for an offline worker waits and arrives at connect", async () => {
  await comment("start with the tests");
  const worker = await fleet.cardd.connect(token);

  assert.deepEqual(
    (await worker.waitForEntries(1)).map((entry) => entry.body),
    ["start with the tests"],
  );
});

test("an older follow-up is resent after a newer steer reached the session file", async () => {
  const worker = await fleet.cardd.connect(token);
  await comment("older follow-up");
  await comment("newer steer", true);
  const [older, newer] = await worker.waitForEntries(2);
  assert.ok(older !== undefined && newer !== undefined);
  worker.ack(newer.id);
  await worker.close();

  const again = await fleet.cardd.connect(token, [newer.id]);
  assert.deepEqual(
    (await again.waitForEntries(1)).map((entry) => entry.body),
    ["older follow-up"],
  );
  assert.equal(again.welcome?.lowWater, older.id - 1);
  await again.close();

  const third = await fleet.cardd.connect(token, [older.id]);
  assert.equal(third.welcome?.lowWater, newer.id);
  await fleet.main.call("board", {});
  assert.deepEqual(third.entries, []);
});

test("an acknowledged entry is resent when the session file lacks it", async () => {
  const worker = await fleet.cardd.connect(token);
  await comment("first steer", true);
  const [first] = await worker.waitForEntries(1);
  assert.ok(first !== undefined);
  worker.ack(first.id);
  await worker.close();

  const again = await fleet.cardd.connect(token, []);
  assert.deepEqual(
    (await again.waitForEntries(1)).map((entry) => [entry.id, entry.body]),
    [[first.id, "first steer"]],
  );
});

test("an unknown token is refused", async () => {
  const stranger = await fleet.cardd.connect("not-a-token");
  assert.equal(stranger.closeCode, 4001);
  assert.equal(stranger.welcome, undefined);
  const worker = await fleet.cardd.connect(token);
  assert.equal(worker.welcome?.role, "worker");
});

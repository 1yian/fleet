// Delivery records and recovery (spec section 9.4), against a real cardd. Every
// worker first gets its task message, which dispatch writes with the attempt.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Card } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
let card: Card;
let token: string;
beforeEach(async () => {
  fleet = await startFleet();
  card = await newCard(fleet.main, "Users see one scrollbar");
  token = await begin(fleet.main, card, "the task");
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const comment = (text: string, now = false): Promise<unknown> =>
  fleet.main.call("comment", { card: card.id, text, now });

test("the task and each comment reach the worker, and now makes a comment a steer", async () => {
  const worker = await fleet.cardd.connect(token);
  await comment("use the v2 endpoint");
  await comment("stop, the API is down", true);
  await worker.waitForEntries(3);

  assert.deepEqual(
    worker.entries.map(({ entry, mode }) => [entry.author, entry.body, mode]),
    [
      ["mate:main", "the task", "followUp"],
      ["mate:main", "use the v2 endpoint", "followUp"],
      ["mate:main", "stop, the API is down", "steer"],
    ],
  );
});

test("entries for an offline worker wait and arrive at connect, in order", async () => {
  await comment("start with the tests");
  const worker = await fleet.cardd.connect(token);

  assert.deepEqual(
    (await worker.waitForEntries(2)).map((entry) => entry.body),
    ["the task", "start with the tests"],
  );
});

test("an older follow-up is resent after a newer steer reached the session file", async () => {
  const worker = await fleet.cardd.connect(token);
  await comment("older follow-up");
  await comment("newer steer", true);
  const [task, older, newer] = await worker.waitForEntries(3);
  assert.ok(task !== undefined && older !== undefined && newer !== undefined);
  worker.ack(newer.id);
  await worker.close();

  const again = await fleet.cardd.connect(token, [task.id, newer.id]);
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
  const [task] = await worker.waitForEntries(1);
  assert.ok(task !== undefined);
  worker.ack(task.id);
  await worker.close();

  const again = await fleet.cardd.connect(token, []);
  assert.deepEqual(
    (await again.waitForEntries(1)).map((entry) => [entry.id, entry.body]),
    [[task.id, "the task"]],
  );
});

test("an unknown token is refused", async () => {
  const stranger = await fleet.cardd.connect("not-a-token");
  assert.equal(stranger.closeCode, 4001);
  assert.equal(stranger.welcome, undefined);
  const worker = await fleet.cardd.connect(token);
  assert.equal(worker.welcome?.role, "worker");
});

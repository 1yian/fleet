import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card } from "@fleet/protocol";
import { newCard, startFleet, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet();
  card = await newCard(fleet.main, "Users see one scrollbar");
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const restartFailed = async (key: string, request: number | undefined, mate = fleet.main) =>
  check(
    OPS["card.restart.failed"].result,
    await mate.call("card.restart.failed", { card: card.id, key, request }),
  );

const requestOf = (plan: { request?: number | undefined }): number => {
  assert.ok(plan.request !== undefined, "an ordinary restart that ran carries its request id");
  return plan.request;
};

const PIN_A = "openai-codex/gpt-fixture";
const PIN_B = "tier/quick";
const PIN_C = "tier/visual";

const restartWithModel = async (key: string, model: string) =>
  check(
    OPS["card.restart"].result,
    await fleet.main.call("card.restart", { card: card.id, mode: "replace", key, model }),
  );

const pinOf = async (): Promise<string | undefined> =>
  check(OPS["attempt.resume"].result, await fleet.main.call("attempt.resume", { card: card.id }))
    .model;

for (const order of [
  ["older first", [0, 1]],
  ["newer first", [1, 0]],
] as const) {
  test(`refunding two overlapping model-changing restarts ${order[0]} puts the worker's model pin back where it was`, async () => {
    await fleet.main.call("attempt.begin", {
      card: card.id,
      host: "maverick",
      task: "Review Spanish copy",
      model: PIN_A,
    });
    await fleet.cardd.connect(
      check(
        OPS["attempt.resume"].result,
        await fleet.main.call("attempt.resume", { card: card.id }),
      ).token,
    );
    const requests = [
      requestOf(await restartWithModel("to-b", PIN_B)),
      requestOf(await restartWithModel("to-c", PIN_C)),
    ];
    const keys = ["to-b", "to-c"];
    assert.equal(await pinOf(), PIN_C);
    for (const [index, which] of order[1].entries()) {
      assert.deepEqual(await restartFailed(keys[which] ?? "", requests[which]), { recorded: true });
      if (index === 0) assert.notEqual(await pinOf(), PIN_A);
    }
    assert.equal(await pinOf(), PIN_A);
  });
}

test("refunding an ordinary restart keeps the model pin a completed incident replacement set", async () => {
  await fleet.main.call("attempt.begin", {
    card: card.id,
    host: "maverick",
    task: "Review Spanish copy",
    model: PIN_A,
  });
  const { token } = check(
    OPS["attempt.resume"].result,
    await fleet.main.call("attempt.resume", { card: card.id }),
  );
  const first = await fleet.cardd.connect(token);
  const { incident } = check(
    OPS["incident.report"].result,
    await first.call("incident.report", { error: "unknown model failure" }),
  );
  await first.close();
  await fleet.main.call("card.restart", {
    card: card.id,
    incident,
    generation: 1,
    mode: "replace",
    key: "recovery",
    model: PIN_C,
  });
  fleet.cardd.startNewProcess(token);
  await fleet.cardd.connect(token);
  assert.equal(await pinOf(), PIN_C);
  const request = requestOf(await restartWithModel("ordinary", "tier/other"));
  assert.equal(await pinOf(), "tier/other");
  assert.deepEqual(await restartFailed("ordinary", request), { recorded: true });
  assert.equal(await pinOf(), PIN_C);
});

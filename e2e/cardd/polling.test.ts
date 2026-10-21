import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

test("cardd's timed check never has more than four gh calls in flight, however many PRs it reads", async () => {
  fleet.cardd.gh.slow(150);
  for (let each = 1; each <= 10; each += 1)
    await begin(fleet.main, await newCard(fleet.main, `card ${String(each)}`));
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    const { started, most } = fleet.cardd.gh.callsInFlight();
    if (started >= 30) {
      assert.ok(most > 1, `the lookups ran side by side: ${String(most)}`);
      assert.ok(most <= 4, `${String(most)} gh calls were in flight at once`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("cardd did not poll thirty times");
});

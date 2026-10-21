import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { begin, branchOf, newCard, startFleet, type Fleet } from "../support/fleet.ts";

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

test("a close that comes while a timed gh read is in flight sees the PR as it is after the call, not the read that began before", async () => {
  const pr = "https://github.com/acme/web/pull/7";
  const card = await newCard(fleet.main, "merged during a read");
  const worker = await fleet.cardd.connect(await begin(fleet.main, card));
  fleet.cardd.gh.setPr(pr, "OPEN", { ci: "pass" });
  fleet.cardd.gh.setHead(pr, branchOf(card));
  await worker.call("report", { status: "done", text: "PR green and ready" });
  fleet.cardd.gh.slow(400);
  for (const deadline = Date.now() + 30_000; fleet.cardd.gh.callsInFlight().now === 0;) {
    assert.ok(Date.now() < deadline, "no timed gh read began");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  fleet.cardd.gh.setPr(pr, "MERGED");
  const plan = check(
    OPS["close.begin"].result,
    await fleet.main.call("close.begin", { card: card.id }),
  );
  assert.deepEqual([plan.mode, plan.verify], ["done", false]);
});

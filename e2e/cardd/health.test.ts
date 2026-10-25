import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { startFleet, type Fleet } from "../support/fleet.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet();
});
afterEach(async () => {
  await fleet.cardd.stop();
});

test("a frozen event loop shows in /api/health and in a timestamped log line", async () => {
  const calm = await fleet.cardd.health();
  assert.ok(calm.loopMaxMs < 1000, "no lag before the freeze");
  assert.equal(calm.lastLagAt, null);
  assert.ok(calm.sockets >= 1, "the connection of the main session is open");
  assert.ok(calm.sessions >= 1, "the main session is live");
  assert.ok(calm.rssBytes > 0);

  await fleet.cardd.freeze(2500);
  const lagged = await fleet.cardd.health();
  assert.ok(lagged.loopMaxMs >= 2000, `loop max ${String(lagged.loopMaxMs)} ms`);
  assert.ok(lagged.lastLagMs >= 2000);
  assert.notEqual(lagged.lastLagAt, null);

  const line = fleet.cardd.output.split("\n").find((each) => each.includes("event loop lag"));
  assert.match(
    line ?? "",
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z warning: event loop lag p99 .* max \d+/,
  );
  for (const each of fleet.cardd.output.split("\n").filter((one) => one !== ""))
    assert.match(each, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /);
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { until } from "../support/live-fleet.ts";
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
  const lagged = await until(async () => {
    const health = await fleet.cardd.health();
    return health.lastLagAt === null ? undefined : health;
  }, "the lag");
  assert.ok(lagged.loopMaxMs >= 2000, `loop max ${String(lagged.loopMaxMs)} ms`);
  assert.ok(lagged.lastLagMs >= 2000);
  assert.notEqual(lagged.lastLagAt, null);

  const line = fleet.cardd.output.split("\n").find((each) => each.includes("event loop lag"));
  assert.match(
    line ?? "",
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z warning: event loop lag \d+ ms, p99 .* max \d+/,
  );
  for (const each of fleet.cardd.output.split("\n").filter((one) => one !== ""))
    assert.match(each, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /);
});

test("a startup failure reaches stderr with a timestamp on every line", () => {
  const failed = fleet.cardd.failToServe("nonsense");
  assert.notEqual(failed.status, 0);
  const lines = failed.stderr.split("\n").filter((one) => one !== "");
  assert.ok(lines.some((each) => each.includes("--listen nonsense must be")));
  for (const each of lines) assert.match(each, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /);
});

test("a second freeze shorter than the first still becomes the latest lag", async () => {
  await fleet.cardd.freeze(2500);
  const first = await until(async () => {
    const health = await fleet.cardd.health();
    return health.lastLagAt === null ? undefined : health;
  }, "the first lag");
  await fleet.cardd.freeze(1500);
  const second = await until(async () => {
    const health = await fleet.cardd.health();
    return health.lastLagAt !== null && health.lastLagAt > (first.lastLagAt ?? 0)
      ? health
      : undefined;
  }, "the second lag");
  assert.ok(second.lastLagMs >= 1000 && second.lastLagMs < first.lastLagMs);
});

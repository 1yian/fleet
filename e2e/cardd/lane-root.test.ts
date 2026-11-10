import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { startFleet, type Fleet } from "../support/fleet.ts";
import { tempDir } from "../support/run-root.ts";

let fleet: Fleet | undefined;
afterEach(async () => {
  await fleet?.cardd.stop();
  fleet = undefined;
});

function advance(clock: string, ms: number): void {
  writeFileSync(`${clock}.next`, new Date(ms).toISOString());
  renameSync(`${clock}.next`, clock);
}

const lossOf = (lane: string) => (entry: { fields: Record<string, unknown>; body: string }) =>
  entry.fields["condition"] === "runtime-failure" && entry.body.includes(lane);

test("a second lane with no parent is refused and the existing root stays", async () => {
  fleet = await startFleet();
  assert.throws(() => fleet?.cardd.addLane("other"), /already a root lane, main/);
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  assert.equal(cleo.welcome?.session, "cleo");
});

test("an abandoned stop hides a lost mate only until the stop ends", async () => {
  const dir = tempDir("lane-stop-");
  mkdirSync(dir, { recursive: true });
  const clock = join(dir, "clock");
  const start = Date.now();
  advance(clock, start);
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001", CARDD_CLOCK_FILE: clock });
  const quiet = await fleet.cardd.connect(fleet.cardd.addLane("quiet", "main"));
  const control = await fleet.cardd.connect(fleet.cardd.addLane("control", "main"));
  const armed = check(
    OPS["lane.stopping"].result,
    await fleet.main.call("lane.stopping", { lane: "quiet" }),
  );
  assert.equal(armed.stopping, true);
  await quiet.lose();
  await control.lose();
  await fleet.main.waitForEntry(lossOf("control"), "the control lane's loss");
  assert.equal(
    fleet.main.entries.some((push) => lossOf("quiet")(push.entry)),
    false,
  );
  advance(clock, start + 60 * 60_000);
  const heard = await fleet.main.waitForEntry(
    lossOf("quiet"),
    "the quiet lane after the stop ended",
  );
  assert.match(heard.body, /quiet its process stopped without a final event/);
});

test("a mate that connects again ends the stop, so a later loss is reported", async () => {
  const dir = tempDir("lane-stop-reconnect-");
  mkdirSync(dir, { recursive: true });
  const clock = join(dir, "clock");
  advance(clock, Date.now());
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001", CARDD_CLOCK_FILE: clock });
  const token = fleet.cardd.addLane("cleo", "main");
  const first = await fleet.cardd.connect(token);
  await fleet.main.call("lane.stopping", { lane: "cleo" });
  await first.lose();
  const second = await fleet.cardd.connect(token);
  await second.lose();
  const heard = await fleet.main.waitForEntry(lossOf("cleo"), "the loss after the mate came back");
  assert.match(heard.body, /cleo its process stopped without a final event/);
});

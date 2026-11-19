import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { test } from "node:test";
import { stopMain } from "../support/disk-session.ts";
import { startMain } from "../support/scratch.ts";
import {
  GIB,
  CROSSED,
  h,
  lab,
  here,
  report,
  callsOf,
  untilCalls,
  afterProbes,
  untilAlarms,
  heldKeys,
  sessionAlarms,
  untilHeld,
  untilSessionAlarms,
  busyMain,
  settledMain,
  crossWhileBusy,
} from "../support/disk-lab.ts";

test("a main that is stopped while its turn still runs and the crossing came meanwhile hears the alarm once after it restarts", async () => {
  const { pane, release } = await busyMain();
  await crossWhileBusy();

  await stopMain(lab, pane);
  release();
  await startMain(lab, here, h, true);
  await h.waitForNth((e) => e["type"] === "fleet_connected", 2, "the restarted main to connect");
  await untilSessionAlarms(1);
  await afterProbes(5);
  assert.equal(sessionAlarms(), 1);
  assert.deepEqual(heldKeys(), CROSSED);
});

test("a turn that outlasts many checks gets one alarm after it ends, and no listing or message while it runs", async () => {
  const { release } = await busyMain();
  await crossWhileBusy();

  release();
  const [alarm] = await untilAlarms(1);
  assert.match(alarm ?? "", /^\[fleet\] disk: far: \/tmp \(tmpfs\) is at 96% of its inodes/);
  await untilSessionAlarms(1);
  await afterProbes(5);
  assert.equal(sessionAlarms(), 1);
  assert.equal(callsOf("largest"), 1);
  assert.deepEqual(heldKeys(), CROSSED);
});

test("a captain who stops main's turn loses no alarm: the alarm comes once the turn is over", async () => {
  const { pane, release } = await busyMain();
  await crossWhileBusy();

  await lab.press(pane, "esc");
  await h.waitFor(
    (e) => e["type"] === "settled" && e["aborted"] === true,
    "the turn to be aborted",
  );
  release();
  await untilSessionAlarms(1);
  await afterProbes(5);
  assert.equal(sessionAlarms(), 1);
  assert.deepEqual(heldKeys(), CROSSED);
});

test("dropping below the alarm and crossing again gives two alarms in all, also across a restart in between", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  const pane = await startMain(lab, here, h);
  await untilSessionAlarms(1);
  report({ inodes: 600_000, bytes: 40 * GIB });
  await untilHeld([]);

  await stopMain(lab, pane);
  await startMain(lab, here, h, true);
  await h.waitForNth((e) => e["type"] === "fleet_connected", 2, "the restarted main to connect");
  await afterProbes(4);
  assert.equal(sessionAlarms(), 1, "below the alarm after the restart, so nothing is said");

  report({ inodes: 1_004_848, bytes: 46 * GIB });
  await untilSessionAlarms(2);
  await afterProbes(4);
  assert.equal(sessionAlarms(), 2);
  assert.deepEqual(heldKeys(), CROSSED);
});

test("an alarm that Pi could not write into main's session file is said again, and counts as said only once it is in the file", async () => {
  const file = await settledMain();
  chmodSync(file, 0o444);
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  await untilCalls("largest", 3);
  assert.equal(sessionAlarms(), 0);

  chmodSync(file, 0o644);
  await untilSessionAlarms(1);
  await afterProbes(5);
  assert.equal(sessionAlarms(), 1);
  assert.deepEqual(heldKeys(), CROSSED);
});

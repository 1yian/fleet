import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { until, replayed, stopMain } from "../support/disk-session.ts";
import { startMain } from "../support/scratch.ts";
import {
  GIB,
  CROSSED,
  h,
  lab,
  here,
  usage,
  log,
  report,
  callsOf,
  untilCalls,
  untilProbes,
  afterProbes,
  alarmsOf,
  lastCall,
  untilAlarms,
  sessionFiles,
  heldKeys,
  alarmCounts,
  sessionAlarms,
  untilHeld,
  untilSessionAlarms,
  settledMain,
} from "../support/disk-lab.ts";

test("a cleared entry that Pi could not write is tried again, so the next crossing is said and not held back", async () => {
  const file = await settledMain();
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  await untilSessionAlarms(1);
  await h.waitForNth((e) => e["type"] === "settled", 2, "the alarm's turn to settle");
  chmodSync(file, 0o444);
  report({ inodes: 600_000, bytes: 40 * GIB });
  await afterProbes(5);
  assert.deepEqual(heldKeys(), CROSSED, "the file still holds the crossing");

  chmodSync(file, 0o644);
  await untilHeld([]);
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  await untilSessionAlarms(2);
  await afterProbes(4);
  assert.equal(sessionAlarms(), 2);
  assert.deepEqual(heldKeys(), CROSSED);
});

test("a new session announces a crossing that is still over the alarm, once", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  const pane = await startMain(lab, here, h);
  await untilSessionAlarms(1);

  await stopMain(lab, pane);
  await startMain(lab, here, h);
  await h.waitForNth((e) => e["type"] === "fleet_connected", 2, "the new session to connect");
  await until(() => sessionFiles().length === 2, "the second session file");
  await until(() => alarmCounts().every((n) => n === 1), "one alarm in each session");
  await afterProbes(5);
  assert.deepEqual(alarmCounts(), [1, 1]);
});

test("a /new typed in the running main announces a crossing that is still over the alarm once in the new session, not again after", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  const pane = await startMain(lab, here, h);
  await untilAlarms(1);
  await untilHeld(CROSSED);

  await lab.submit(pane, "/new");
  await until(() => sessionFiles().length === 2, "the new session's file");
  await until(() => alarmCounts().every((n) => n === 1), "one alarm in each session");
  await afterProbes(5);
  assert.deepEqual(alarmCounts(), [1, 1]);
  assert.equal(alarmsOf(lastCall()).length, 1, "the new conversation holds its own single alarm");
  assert.deepEqual(sessionFiles().map(replayed), [CROSSED, CROSSED]);
});

test("a host whose lanes cannot be kept up still has its disk use read, pruned, and alarmed", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  writeFileSync(`${usage}.lanes-fail`, "");
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  const pane = await startMain(lab, here, h);
  const [alarm] = await untilAlarms(1);
  assert.match(alarm ?? "", /^\[fleet\] disk: far: \/tmp \(tmpfs\) is at 96% of its inodes/);
  await afterProbes(4);
  assert.equal(alarmsOf(lastCall()).length, 1);
  assert.ok(readFileSync(log, "utf8").includes("probe tidy"), "the hourly tidy was asked for");
  const said = (await lab.history(pane)).replace(/\s+/g, " ");
  assert.equal(said.split("lanes: far failed:").length - 1, 1);
  assert.match(said, /could not create the workspace of ops/);
  assert.match(said, /cleo started on far/);
  assert.doesNotMatch(said, /far can be reached again/);
});

test("a directory listing that fails is retried on the next checks, and main hears one alarm that names the directories", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  writeFileSync(`${usage}.largest-fails`, "2");
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  await startMain(lab, here, h);
  const [alarm] = await untilAlarms(1);
  assert.match(alarm ?? "", /Largest under \/tmp by inodes: \/tmp\/fleet-c-1300 88,085 inodes;/);
  assert.doesNotMatch(alarm ?? "", /could not be read/);
  assert.equal(callsOf("largest"), 3);
  await afterProbes(4);
  assert.equal(alarmsOf(lastCall()).length, 1);
  assert.equal(callsOf("largest"), 3);
  assert.deepEqual(heldKeys(), ["far|/tmp|inodes"]);
});

test("a directory listing that never works is retried for three checks, then main hears one alarm without directories", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  writeFileSync(`${usage}.largest-fails`, "1000");
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  await startMain(lab, here, h);
  const [alarm] = await untilAlarms(1);
  assert.match(
    alarm ?? "",
    /is at 96% of its inodes \(1,004,848 of 1,048,576\), at or over the 75% alarm\. The largest directories could not be read\. /,
  );
  assert.equal(callsOf("largest"), 3);
  await afterProbes(4);
  assert.equal(alarmsOf(lastCall()).length, 1);
  assert.equal(callsOf("largest"), 3);
  assert.deepEqual(heldKeys(), ["far|/tmp|inodes"]);
});

test("a failed listing is not counted toward a later crossing: after the use drops below the alarm, the count starts again", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  const hold = `${usage}.hold`;
  writeFileSync(hold, "");
  writeFileSync(`${usage}.largest-fails`, "1000");
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  await startMain(lab, here, h);
  await untilCalls("largest", 1);
  report({ inodes: 600_000, bytes: 40 * GIB });
  rmSync(hold);
  await afterProbes(3);
  assert.equal(alarmsOf(lastCall()).length, 0);

  report({ inodes: 1_004_848, bytes: 46 * GIB });
  const [alarm] = await untilAlarms(1);
  assert.match(alarm ?? "", /The largest directories could not be read\./);
  assert.equal(callsOf("largest"), 4);
});

test("a host that cannot report its disk use is named once, and the lanes check goes on", async () => {
  writeFileSync(usage, "usage: fleet status | up\n");
  const pane = await startMain(lab, here, h);
  await untilProbes(4);
  const said = (await lab.history(pane)).replace(/\s+/g, " ");
  assert.equal(said.split("the disk use of far could not be read").length - 1, 1);
  assert.equal(said.includes("disk: far:"), false);
});

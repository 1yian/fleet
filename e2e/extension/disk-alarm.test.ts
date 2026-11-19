import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { stopMain } from "../support/disk-session.ts";
import { publishRecord } from "../support/json.ts";
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
  sessionText,
  heldKeys,
  untilHeld,
} from "../support/disk-lab.ts";

test("main hears once when a host's filesystem reaches 75%, and again only after it drops below 70% and reaches 75% again", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);
  await untilProbes(3);
  assert.equal(sessionText().includes("[fleet] disk: far:"), false);

  report({ inodes: 1_004_848, bytes: 46 * GIB });
  const [first] = await untilAlarms(1);
  assert.equal(
    first,
    "[fleet] disk: far: /tmp (tmpfs) is at 96% of its inodes (1,004,848 of 1,048,576), at or over the 75% alarm. Largest under /tmp by inodes: /tmp/fleet-c-1300 88,085 inodes; /tmp/fleet-c-1289 67,375 inodes; /tmp/node-compile-cache 21,377 inodes. This is said once. It is said again only after its inodes drop below 70% and reach 75% again.",
  );

  for (const inodes of [1_040_000, 780_000, 800_000, 780_000, 800_000, 780_000, 800_000]) {
    report({ inodes, bytes: 40 * GIB });
    await afterProbes(3);
  }
  assert.equal(alarmsOf(lastCall()).length, 1, "oscillating around 75% does not re-arm it");

  report({ inodes: 700_000, inodesTotal: 1_000_000, bytes: 40 * GIB });
  await afterProbes(3);
  assert.deepEqual(heldKeys(), CROSSED, "70% does not re-arm it");
  report({ inodes: 733_000, bytes: 40 * GIB });
  await untilHeld([]);
  const listed = callsOf("largest");
  report({ inodes: 780_000, bytes: 40 * GIB });
  await afterProbes(3);
  assert.equal(alarmsOf(lastCall()).length, 1, "below 75% an unheld alarm does not fire");
  assert.equal(callsOf("largest"), listed, "below 75% nothing is listed");
  report({ inodes: 786_432, bytes: 40 * GIB });
  const alarms = await untilAlarms(2);
  assert.match(alarms[1] ?? "", /is at 75% of its inodes \(786,432 of 1,048,576\)/);
  await afterProbes(4);
  assert.equal(alarmsOf(lastCall()).length, 2);
});

test("main names the directories of every watched root on the filesystem that crossed, not only /tmp", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  const folder = "/home/far/.fleet";
  report({ inodes: 1_004_848, bytes: 46 * GIB }, ["/tmp", folder]);
  publishRecord(`${usage}.largest`, {
    filesystem: "/dev/nvme0n1p2",
    partial: false,
    largest: [
      { name: `${folder}/node-compile-cache`, inodes: 700_000, bytes: 9 * GIB },
      { name: `${folder}/scratch`, inodes: 250_000, bytes: 30 * GIB },
      { name: "/tmp/fleet-c-1300", inodes: 4_000, bytes: GIB },
    ],
  });
  await startMain(lab, here, h);
  const [alarm] = await untilAlarms(1);
  assert.equal(
    alarm,
    "[fleet] disk: far: /tmp (/dev/nvme0n1p2) is at 96% of its inodes (1,004,848 of 1,048,576), at or over the 75% alarm. Largest under /tmp, /home/far/.fleet by inodes: /home/far/.fleet/node-compile-cache 700,000 inodes; /home/far/.fleet/scratch 250,000 inodes; /tmp/fleet-c-1300 4,000 inodes. This is said once. It is said again only after its inodes drop below 70% and reach 75% again.",
  );
  const asked = readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("largest"));
  assert.ok(asked.length > 0);
  assert.deepEqual([...new Set(asked)], [`largest /tmp ${folder}`]);
});

test("main names space when space is what crossed, and counts inodes and space separately", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);
  await untilProbes(2);
  report({ inodes: 600_000, bytes: 100 * GIB });
  const [space] = await untilAlarms(1);
  assert.match(
    space ?? "",
    /^\[fleet\] disk: far: \/tmp \(tmpfs\) is at 81% of its space \(100\.0 GB of 124\.0 GB\), at or over the 75% alarm\. Largest under \/tmp by space: \/tmp\/fleet-c-1300 5\.0 GB;/,
  );
  report({ inodes: 1_000_000, bytes: 100 * GIB });
  const alarms = await untilAlarms(2);
  assert.match(alarms[1] ?? "", /is at 95% of its inodes/);
  await afterProbes(4);
  assert.equal(alarmsOf(lastCall()).length, 2);
});

test("a restarted main does not say again that a filesystem is still over the alarm", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  const pane = await startMain(lab, here, h);
  await untilAlarms(1);
  await untilHeld(CROSSED);

  await stopMain(lab, pane);
  await startMain(lab, here, h, true);
  await h.waitForNth((e) => e["type"] === "fleet_connected", 2, "the restarted main to connect");
  await afterProbes(5);
  const said = sessionText().split("[fleet] disk: far:").length - 1;
  assert.equal(said, 1);
});

test("a main that stopped before the alarm reached it hears the alarm once after it restarts", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  const hold = `${usage}.hold`;
  writeFileSync(hold, "");
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  const pane = await startMain(lab, here, h);
  await untilCalls("largest", 1);
  await stopMain(lab, pane);
  rmSync(hold);
  assert.equal(sessionText().includes("[fleet] disk: far:"), false);

  await startMain(lab, here, h, true);
  await h.waitForNth((e) => e["type"] === "fleet_connected", 2, "the restarted main to connect");
  const [alarm] = await untilAlarms(1);
  assert.match(alarm ?? "", /^\[fleet\] disk: far: \/tmp \(tmpfs\) is at 96% of its inodes/);
  await afterProbes(5);
  assert.equal(sessionText().split("[fleet] disk: far:").length - 1, 1);
  assert.deepEqual(heldKeys(), ["far|/tmp|inodes"]);
});

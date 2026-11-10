import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { publishRecord, records, type JsonRecord } from "../support/json.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TRANSPORT = fileURLToPath(new URL("../support/disk-transport.ts", import.meta.url));
const INODES = 1_048_576;
const GIB = 2 ** 30;

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let far: Scratch;
let usage: string;
let log: string;

beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  here = new Scratch();
  far = new Scratch();
  usage = join(here.parent, "far-usage.json");
  log = join(here.parent, "far-calls.log");
  report({ inodes: 600_000, bytes: 40 * GIB });
  publishRecord(`${usage}.largest`, {
    filesystem: "tmpfs",
    partial: false,
    largest: [
      { name: "/tmp/fleet-c-1300", inodes: 88_085, bytes: 5 * GIB },
      { name: "/tmp/fleet-c-1289", inodes: 67_375, bytes: 3 * GIB },
      { name: "/tmp/node-compile-cache", inodes: 21_377, bytes: 2 * GIB },
    ],
  });
  const mainToken = cardd.addLane("main", undefined, here.root);
  configureMain(here, cardd.url, mainToken, {
    hosts: { far: ["node", TRANSPORT, usage, log] },
    roots: { far: far.root },
  });
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
    FLEET_SUPERVISE_MS: "300",
  });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  far.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

function report(
  { inodes, bytes }: { inodes: number; bytes: number },
  roots?: readonly string[],
): void {
  const row: JsonRecord = {
    path: "/tmp",
    ...(roots === undefined ? {} : { roots: [...roots] }),
    inodesUsed: inodes,
    inodesTotal: INODES,
    bytesUsed: bytes,
    bytesTotal: 124 * GIB,
  };
  publishRecord(usage, { host: "far", filesystems: [row] });
}

const callsOf = (kind: "probe" | "largest"): number =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith(kind)).length
    : 0;

const probes = (): number => callsOf("probe");

async function untilCalls(kind: "probe" | "largest", count: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (callsOf(kind) < count) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${String(count)} ${kind} calls to far`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const untilProbes = (count: number): Promise<void> => untilCalls("probe", count);

const afterProbes = (more: number): Promise<void> => untilProbes(probes() + more);

const sessionText = (): string =>
  readdirSync(join(h.dir, "sessions"))
    .map((file) => readFileSync(join(h.dir, "sessions", file), "utf8"))
    .join("\n");

const alarmsOf = (turns: Turn[]): string[] =>
  turns
    .filter((turn) => turn.role === "user" && turn.text.includes("[fleet] disk: far:"))
    .map((turn) => turn.text);

const lastCall = (): Turn[] => h.callsOf("mate").at(-1) ?? [];

async function untilAlarms(count: number): Promise<string[]> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const alarms = alarmsOf(lastCall());
    if (alarms.length >= count) return alarms;
    assert.ok(Date.now() < deadline, `timed out waiting for ${String(count)} alarms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const heldKeys = (): unknown[] => {
  const held: unknown = JSON.parse(
    readFileSync(join(here.root, "state", "disk-alarms.json"), "utf8"),
  );
  return Array.isArray(held)
    ? held.filter((key) => typeof key === "string" && key.startsWith("far|"))
    : [];
};

test("main hears once when a host's filesystem passes 75%, and again only after it drops below and crosses again", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  await startMain(lab, here, h);
  await untilProbes(3);
  assert.equal(sessionText().includes("[fleet] disk: far:"), false);

  report({ inodes: 1_004_848, bytes: 46 * GIB });
  const [first] = await untilAlarms(1);
  assert.equal(
    first,
    "[fleet] disk: far: /tmp (tmpfs) is at 96% of its inodes (1,004,848 of 1,048,576), over the 75% alarm. Largest under /tmp by inodes: /tmp/fleet-c-1300 88,085 inodes; /tmp/fleet-c-1289 67,375 inodes; /tmp/node-compile-cache 21,377 inodes. This is said once. It is said again only after /tmp drops below 75% and crosses it again.",
  );

  await afterProbes(5);
  report({ inodes: 1_040_000, bytes: 50 * GIB });
  await afterProbes(5);
  assert.equal(alarmsOf(lastCall()).length, 1, "still over 75%, so nothing more was said");
  assert.deepEqual(heldKeys(), ["far|/tmp|inodes"]);

  report({ inodes: 600_000, bytes: 40 * GIB });
  await afterProbes(3);
  assert.deepEqual(heldKeys(), []);
  assert.equal(alarmsOf(lastCall()).length, 1);

  report({ inodes: 900_000, bytes: 40 * GIB });
  const alarms = await untilAlarms(2);
  assert.match(alarms[1] ?? "", /is at 86% of its inodes \(900,000 of 1,048,576\)/);
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
    "[fleet] disk: far: /tmp (/dev/nvme0n1p2) is at 96% of its inodes (1,004,848 of 1,048,576), over the 75% alarm. Largest under /tmp, /home/far/.fleet by inodes: /home/far/.fleet/node-compile-cache 700,000 inodes; /home/far/.fleet/scratch 250,000 inodes; /tmp/fleet-c-1300 4,000 inodes. This is said once. It is said again only after /tmp drops below 75% and crosses it again.",
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
    /^\[fleet\] disk: far: \/tmp \(tmpfs\) is at 81% of its space \(100\.0 GB of 124\.0 GB\), over the 75% alarm\. Largest under \/tmp by space: \/tmp\/fleet-c-1300 5\.0 GB;/,
  );
  report({ inodes: 1_000_000, bytes: 100 * GIB });
  const alarms = await untilAlarms(2);
  assert.match(alarms[1] ?? "", /is at 95% of its inodes/);
  await afterProbes(4);
  assert.equal(alarmsOf(lastCall()).length, 2);
});

async function stopMain(pane: string): Promise<void> {
  const before = records([
    (await lab.run(["pane", "process-info", "--pane", pane]))["process_info"],
  ]);
  const group = Number(before[0]?.["foreground_process_group_id"]);
  const shell = Number(before[0]?.["shell_pid"]);
  process.kill(-group, "SIGKILL");
  const deadline = Date.now() + 30_000;
  for (;;) {
    const info = records([
      (await lab.run(["pane", "process-info", "--pane", pane]))["process_info"],
    ]);
    if (Number(info[0]?.["foreground_process_group_id"]) === shell) break;
    assert.ok(Date.now() < deadline, "the mate's pane did not return to its shell");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("a restarted main does not say again that a filesystem is still over the alarm", async () => {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  const pane = await startMain(lab, here, h);
  await untilAlarms(1);

  await stopMain(pane);
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
  await stopMain(pane);
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
  assert.match(said, /the workspace of ops has no pane/);
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
    /is at 96% of its inodes \(1,004,848 of 1,048,576\), over the 75% alarm\. The largest directories could not be read\. /,
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

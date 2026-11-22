import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach } from "node:test";
import { Cardd } from "./cardd.ts";
import { until, replayed } from "./disk-session.ts";
import { gate, Harness, type Turn } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { publishRecord, type JsonRecord } from "./json.ts";
import { configureMain, Scratch, startMain } from "./scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TRANSPORT = fileURLToPath(new URL("./disk-transport.ts", import.meta.url));
const INODES = 1_048_576;
export const GIB = 2 ** 30;
export const CROSSED = ["far|/tmp|inodes"];
const ALARM = "[fleet] disk: far:";

let cardd: Cardd;
export let h: Harness;
export let lab: HerdrLab;
export let here: Scratch;
let far: Scratch;
export let usage: string;
export let log: string;
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
    FLEET_SUPERVISE_MS: "100",
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

export function report(
  { inodes, bytes, inodesTotal = INODES }: { inodes: number; bytes: number; inodesTotal?: number },
  roots?: readonly string[],
): void {
  const row: JsonRecord = {
    path: "/tmp",
    ...(roots === undefined ? {} : { roots: [...roots] }),
    inodesUsed: inodes,
    inodesTotal,
    bytesUsed: bytes,
    bytesTotal: 124 * GIB,
  };
  publishRecord(usage, { host: "far", filesystems: [row] });
}

export const callsOf = (kind: "probe" | "largest"): number =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith(kind)).length
    : 0;

const probes = (): number => callsOf("probe");

export async function untilCalls(kind: "probe" | "largest", count: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (callsOf(kind) < count) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${String(count)} ${kind} calls to far`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const untilProbes = (count: number): Promise<void> => untilCalls("probe", count);

export const afterProbes = (more: number): Promise<void> => untilProbes(probes() + more);

export const alarmsOf = (turns: Turn[]): string[] =>
  turns
    .filter((turn) => turn.role === "user" && turn.text.includes("[fleet] disk: far:"))
    .map((turn) => turn.text);

export const lastCall = (): Turn[] => h.callsOf("mate").at(-1) ?? [];

export async function untilAlarms(count: number): Promise<string[]> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const alarms = alarmsOf(lastCall());
    if (alarms.length >= count) return alarms;
    assert.ok(Date.now() < deadline, `timed out waiting for ${String(count)} alarms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const sessionFiles = (): string[] => {
  const folder = join(h.dir, "sessions");
  return existsSync(folder)
    ? readdirSync(folder)
        .sort()
        .map((file) => join(folder, file))
    : [];
};

export const sessionText = (): string =>
  sessionFiles()
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

export const heldKeys = (): string[] => sessionFiles().flatMap(replayed);

export const alarmCounts = (): number[] =>
  sessionFiles().map((file) => readFileSync(file, "utf8").split(ALARM).length - 1);

export const sessionAlarms = (): number => sessionText().split(ALARM).length - 1;

export const untilHeld = (keys: readonly unknown[]): Promise<void> =>
  until(
    () => JSON.stringify(heldKeys()) === JSON.stringify(keys),
    `the held crossings ${keys.join()}`,
  );

export const untilSessionAlarms = (count: number): Promise<void> =>
  until(() => sessionAlarms() >= count, `${String(count)} alarms in main's session file`);

export async function busyMain(): Promise<{ pane: string; release: () => void }> {
  const turn = gate();
  h.onModel(async () => {
    await turn.wait;
    return { text: "noted" };
  }, "mate");
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  const pane = await startMain(lab, here, h);
  await h.waitFor((e) => e["type"] === "fleet_connected", "main to connect");
  await untilProbes(2);
  await lab.submit(pane, "hello");
  await h.waitForCall(0, "mate", WAIT_MS);
  return { pane, release: turn.open };
}

export async function settledMain(): Promise<string> {
  for (let call = 0; call < 8; call += 1) h.onModel(() => ({ text: "noted" }), "mate");
  const pane = await startMain(lab, here, h);
  await h.waitFor((e) => e["type"] === "fleet_connected", "main to connect");
  await untilProbes(2);
  await lab.submit(pane, "hello");
  await h.waitForNth((e) => e["type"] === "settled", 1, "the first turn to settle");
  const [file] = sessionFiles();
  assert.ok(file !== undefined, "the first turn wrote main's session file");
  return file;
}

export async function crossWhileBusy(): Promise<void> {
  report({ inodes: 1_004_848, bytes: 46 * GIB });
  await afterProbes(4);
  assert.equal(callsOf("largest"), 0, "nothing is listed or sent while the turn runs");
  assert.equal(sessionAlarms(), 0);
  assert.deepEqual(heldKeys(), []);
}

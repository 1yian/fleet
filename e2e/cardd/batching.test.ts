import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { tempDir } from "../support/run-root.ts";

const SCALE = 0.01;
const WINDOW = 5 * 60_000 * SCALE;
const START = Date.parse("2026-05-04T08:00:00Z");
const TICK_MS = 600;

let fleet: Fleet;
let clockFile: string;
beforeEach(async () => {
  const dir = tempDir("fleet-clock-");
  mkdirSync(dir, { recursive: true });
  clockFile = join(dir, "clock");
  setClock(START);
  fleet = await startFleet({ CARDD_TIMING_SCALE: String(SCALE), CARDD_CLOCK_FILE: clockFile });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

function setClock(ms: number): void {
  const next = `${clockFile}.next`;
  writeFileSync(next, new Date(ms).toISOString());
  renameSync(next, clockFile);
}

async function workerInCleo(cleo: Session): Promise<Session> {
  const card = await newCard(cleo, "Users see one scrollbar");
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  worker.send({ t: "activity", state: "running" });
  return worker;
}

const bodies = (session: Session): string[] => session.entries.map(({ entry }) => entry.body);
const afterTicks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3 * TICK_MS));

test("routine notices wait for the five minute window and arrive together, in order", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"), [], false);
  const worker = await workerInCleo(cleo);
  const before = cleo.entries.length;
  await worker.call("report", { status: "in-review", text: "first" });
  await worker.call("report", { status: "in-review", text: "second" });
  await worker.call("report", { status: "in-review", text: "third" });

  setClock(START + WINDOW - 1);
  await afterTicks();
  assert.deepEqual(bodies(cleo).slice(before), [], "nothing arrives before the window ends");

  setClock(START + WINDOW);
  await cleo.waitForEntry((entry) => entry.body === "third", "the batch");
  assert.deepEqual(bodies(cleo).slice(before), ["first", "second", "third"]);
});

test("an action notice arrives at once and carries the pending batch", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"), [], false);
  const worker = await workerInCleo(cleo);
  const before = cleo.entries.length;
  await worker.call("report", { status: "in-review", text: "routine" });
  await afterTicks();
  assert.equal(cleo.entries.length, before, "the routine notice is held");

  await worker.call("report", { status: "blocked", text: "stuck" });
  await cleo.waitForEntry((entry) => entry.body === "stuck", "the action notice");
  assert.deepEqual(bodies(cleo).slice(before), ["routine", "stuck"]);
});

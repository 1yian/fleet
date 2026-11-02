import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { startFleet, type Fleet } from "../support/fleet.ts";
import { tempDir } from "../support/run-root.ts";

const TEXT = "Good morning. Write today's daily update.\nInclude yesterday's numbers.";
const isText = (entry: Entry): boolean => entry.fields["wake"] === "message" && entry.body === TEXT;
const isMarker = (entry: Entry): boolean =>
  entry.fields["wake"] === "message" && entry.body === "marker";

let fleet: Fleet;
let clock: string;
let ads: Session;
let cleo: Session;
let main: Session;

const setClock = (iso: string): void => {
  const next = `${clock}.${randomUUID()}.tmp`;
  writeFileSync(next, iso);
  renameSync(next, clock);
};

beforeEach(async () => {
  const dir = tempDir("schedules-");
  mkdirSync(dir, { recursive: true });
  clock = join(dir, "clock");
  setClock("2026-05-04T04:59:00Z");
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.01", CARDD_CLOCK_FILE: clock });
  ads = await fleet.cardd.connect(fleet.cardd.addLane("ads", "main"));
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  main = await fleet.cardd.connect(fleet.mainToken, [], false);
});
afterEach(async () => {
  await Promise.allSettled([ads.close(), cleo.close(), main.close()]);
  await fleet.cardd.stop();
});

async function set(who: Session, more: Record<string, unknown> = {}): Promise<number> {
  const args = { to: "main", at: "05:00", timezone: "UTC", text: TEXT, ...more };
  return check(OPS["schedule.set"].result, await who.call("schedule.set", args)).id;
}

const heard = (who: Session, match: (entry: Entry) => boolean): Entry[] =>
  who.entries.map(({ entry }) => entry).filter(match);

test("a mate's schedule reaches main at its time word for word, is resent until read, shows on the board, and stops when removed", async () => {
  const id = await set(ads);
  assert.deepEqual(
    (await fleet.cardd.board()).schedules.map((each) => [each.owner, each.to, each.at, each.text]),
    [["ads", "main", "05:00", TEXT]],
  );
  assert.deepEqual(heard(main, isText), []);

  setClock("2026-05-04T05:00:00Z");
  const first = await main.waitForEntry(isText, "main to hear the scheduled message");
  assert.equal(first.author, "schedule");
  assert.equal(first.fields["from"], "ads");
  await main.waitForEntries(3);
  const sends = main.entries.filter(({ entry }) => isText(entry));
  assert.equal(sends[0]?.again ?? false, false);
  assert.equal(sends[1]?.again, true);
  assert.equal(new Set(sends.map(({ entry }) => entry.id)).size, 1);

  await ads.call("schedule.remove", { id });
  assert.deepEqual((await fleet.cardd.board()).schedules, []);
  await set(cleo, { text: "marker", at: "05:00" });
  setClock("2026-05-05T05:00:00Z");
  const marker = await main.waitForEntry(isMarker, "main to hear the marker schedule");
  const read = (): number => heard(main, (entry) => isText(entry) && entry.id < marker.id).length;
  assert.equal(heard(main, (entry) => isText(entry) && entry.id > first.id).length, 0);
  assert.ok(read() >= 1);
});

test("a schedule can deliver to a mate, run once on a date, and be changed by its owner only", async () => {
  const id = await set(ads, { to: "cleo", on: "2026-05-04", at: "06:00" });
  await assert.rejects(set(cleo, { id }), /belongs to ads/);
  await assert.rejects(cleo.call("schedule.remove", { id }), /belongs to ads/);
  assert.equal(check(OPS["schedule.list"].result, await cleo.call("schedule.list", {})).length, 0);
  assert.equal(check(OPS["schedule.list"].result, await main.call("schedule.list", {})).length, 1);

  await set(ads, { id, to: "cleo", on: "2026-05-04", at: "06:30", text: "Review the spend" });
  setClock("2026-05-04T06:30:00Z");
  const note = await cleo.waitForEntry((entry) => entry.body === "Review the spend", "cleo");
  assert.equal(note.fields["from"], "ads");
  assert.deepEqual((await fleet.cardd.board()).schedules, []);
});

test("a daily schedule does not repeat a delivered slot when the clock falls back", async () => {
  setClock("2026-10-31T00:00:00Z");
  await set(ads, { at: "01:30", timezone: "America/Chicago" });
  setClock("2026-11-01T06:30:00Z");
  const first = await main.waitForEntry(isText, "main to hear the 01:30 message");
  setClock("2026-11-01T07:00:00Z");
  await set(cleo, { text: "marker", at: "01:00", timezone: "America/Chicago" });
  const marker = await main.waitForEntry(isMarker, "main to hear the marker schedule");
  assert.equal(heard(main, (entry) => isText(entry) && entry.id !== first.id).length, 0);
  assert.ok(marker.id > first.id);
});

test("an unknown recipient, a bad zone, a past one-shot, and an empty text are refused", async () => {
  await assert.rejects(set(ads, { to: "nobody" }), /no lane nobody/);
  await assert.rejects(set(ads, { timezone: "Mars/Base" }), /timezone/);
  await assert.rejects(set(ads, { on: "2026-05-03" }), /already passed/);
  await assert.rejects(set(ads, { on: "2027-02-30" }), /not a date/);
  await assert.rejects(set(ads, { text: "  " }));
  assert.deepEqual((await fleet.cardd.board()).schedules, []);
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { get } from "node:http";
import type { Fleet } from "../support/fleet.ts";
import { begin, newCard, startFleet } from "../support/fleet.ts";

const CLOSED_CARDS = 500;
const COMMENTS_PER_CARD = 22;
const PROBES = 100;
const PROBE_EVERY_MS = 100;

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.01" });
});
afterEach(async () => {
  await fleet.cardd.stop();
});

async function seedClosedCard(index: number): Promise<void> {
  const card = await newCard(fleet.main, `history ${String(index)}`);
  for (let at = 0; at < COMMENTS_PER_CARD; at++)
    await fleet.main.call("comment", {
      card: card.id,
      text: `note ${String(at)} on ${card.title}`,
    });
  await fleet.main.call("close.begin", { card: card.id, landed: false });
  await fleet.main.call("close.finish", {
    card: card.id,
    mode: "dropped",
    text: "history",
    archives: [],
    left: [],
  });
}

function probe(url: string): Promise<number> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const request = get(url, { agent: false, timeout: 5000 }, (response) => {
      response.resume();
      response.on("end", () => {
        if (response.statusCode === 200) resolve(performance.now() - started);
        else reject(new Error(`status ${String(response.statusCode)}`));
      });
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
  });
}

test("fresh connections and new sessions stay fast while cardd carries a long history", async () => {
  const lanes = 5;
  await Promise.all(
    Array.from({ length: lanes }, async (_, lane) => {
      for (let index = lane; index < CLOSED_CARDS; index += lanes) await seedClosedCard(index);
    }),
  );
  const url = fleet.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/api/version");

  const live = await newCard(fleet.main, "a card that is still open");
  const token = await begin(fleet.main, live);
  const times: number[] = [];
  const failures: string[] = [];
  const pending: Promise<void>[] = [];
  for (let at = 0; at < PROBES; at++) {
    pending.push(
      probe(url).then(
        (ms) => void times.push(ms),
        (error: unknown) => void failures.push(String(error)),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, PROBE_EVERY_MS));
  }
  await Promise.all(pending);
  assert.deepEqual(failures, []);
  const sorted = times.toSorted((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? Infinity;
  assert.ok(p95 < 250, `p95 of fresh connections was ${p95.toFixed(0)} ms`);

  const asked = performance.now();
  await fleet.cardd.connect(token);
  const welcomed = performance.now() - asked;
  assert.ok(welcomed < 2000, `the welcome took ${welcomed.toFixed(0)} ms`);
});

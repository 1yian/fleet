import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Entry } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Pi } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const MODEL = "claude-fable-5-2";
const PIN = ["--provider", "anthropic-3", "--model", `${MODEL}:medium`];
const RATE_LIMIT =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your account"}}';
const OUT_OF_QUOTA =
  "insufficient_quota: you exceeded your current quota, check your plan and billing";

let fleet: Fleet;
let h: Harness;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.02" });
  h = await Harness.start();
  const agent = join(h.dir, "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(
    join(agent, "tiers.json"),
    JSON.stringify({ accounts: { claude: ["anthropic-2", "anthropic-3", "anthropic-4"] } }),
  );
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 20, maxAgentDelayMs: 50 },
    }),
  );
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

const isFailure = (entry: Entry): boolean => entry.fields["condition"] === "runtime-failure";

async function dispatched(extra: readonly string[] = []): Promise<() => Pi> {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const token = await begin(fleet.main, card, "the task");
  return () =>
    h.startPi(
      "c-1-a1",
      { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" },
      [EXTENSION],
      [...PIN, ...extra],
    );
}

async function callsOn(count: number): Promise<string[]> {
  await h.waitForCall(count - 1);
  return h.modelsOf("default");
}

test("a worker pinned to a model on one account moves to another account that serves the same model when the first answers 429, and keeps the pinned thinking level", async () => {
  h.onModel(() => ({ fail: RATE_LIMIT }));
  h.onModel(() => ({ text: "carrying on from the second account" }));
  const worker = (await dispatched())();
  const [first, ...later] = await callsOn(2);
  assert.equal(first, `anthropic-3/${MODEL}`);
  assert.ok(later.length > 0);
  assert.deepEqual([...new Set(later)], [`anthropic-2/${MODEL}`]);
  assert.equal((await worker.state())["thinkingLevel"], "medium");
});

test("a worker whose every account for the model is limited fails with the model and the accounts named, and stops asking", async () => {
  h.onModel(() => ({ fail: RATE_LIMIT }));
  h.onModel(() => ({ fail: RATE_LIMIT }));
  (await dispatched())();
  const heard = await fleet.main.waitForEntry(isFailure, "the exhaustion to reach the mate");
  assert.match(heard.body, new RegExp(`no usable account for ${MODEL}`));
  assert.match(heard.body, /anthropic-3 \(throttled until/);
  assert.match(heard.body, /anthropic-2 \(throttled until/);
  assert.match(heard.body, /anthropic-4 \(does not serve it\)/);
  assert.match(heard.body, /Classified router-cooldown\./);
  const until = /anthropic-3 \(throttled until (\S+?)\)/.exec(heard.body)?.[1];
  assert.ok(until !== undefined);
  assert.ok(heard.body.includes(`eligible at ${until}.`), heard.body);
  assert.deepEqual(h.modelsOf("default"), [`anthropic-3/${MODEL}`, `anthropic-2/${MODEL}`]);
});

test("a replaced worker does not start again on the account that ran out of quota", async () => {
  h.onModel(() => ({ fail: OUT_OF_QUOTA }));
  h.onModel(() => ({ text: "carrying on from the second account" }));
  const start = await dispatched();
  const first = start();
  const heard = await fleet.main.waitForEntry(isFailure, "the quota failure to reach the mate");
  assert.match(heard.body, /insufficient_quota/);
  await first.kill();
  start();
  const [before, after] = await callsOn(2);
  assert.equal(before, `anthropic-3/${MODEL}`);
  assert.equal(after, `anthropic-2/${MODEL}`);
});

test("a restart that avoids the other account leaves the pinned worker no account to move to, and the failure says so", async () => {
  h.onModel(() => ({ fail: RATE_LIMIT }));
  (await dispatched(["--fleet-avoid=anthropic-2"]))();
  const heard = await fleet.main.waitForEntry(isFailure, "the exhaustion to reach the mate");
  assert.match(heard.body, /anthropic-3 \(throttled until/);
  assert.match(heard.body, /anthropic-2 \(avoided by the restart\)/);
  assert.deepEqual(h.modelsOf("default"), [`anthropic-3/${MODEL}`]);
});

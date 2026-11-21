import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { poll } from "../support/harness.ts";
import {
  mateConnected,
  sessionGeneration,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workerHelloAdopted,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { tempDir } from "../support/run-root.ts";

const READINESS = fileURLToPath(new URL("../support/readiness-transport.ts", import.meta.url));
const CHECKOUT = fileURLToPath(new URL("../..", import.meta.url));
const DISPATCH = {
  tool: "dispatch",
  args: {
    title: "Users see one scrollbar",
    name: "one-scrollbar",
    kind: "ship",
    project: "site",
    intent: "Fix the scrollbar",
    host: "far",
    task: "fix the scrollbar",
  },
} as const;

let parts: DispatchLab;
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

test("a start refused because another Pi holds the pane never counts toward the hourly cap", async () => {
  const armed = join(tempDir("start-occupied-"), "armed");
  parts = await startDispatchLab({
    hosts: { far: ["node", READINESS, armed] },
    roots: { far: CHECKOUT },
  });
  const { cardd, h, mate } = parts;
  const restart = { tool: "restart_card", args: { card: 1 } };
  h.onModel(() => DISPATCH, "mate");
  h.onModel(() => {
    writeFileSync(armed, "refuse-occupied\n");
    return restart;
  }, "mate");
  for (let refused = 1; refused < 4; refused += 1) h.onModel(() => restart, "mate");
  h.onModel(() => ({ text: "refused" }), "mate");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  const results = toolResults(await h.waitForCall(5, "mate", WORKER_WAIT_MS));
  assert.match(results.at(-5) ?? "", /^Dispatched c-1-a1 on far/);
  for (const result of results.slice(-4)) {
    assert.match(result, /fixture refused the start --fleet-token \[hidden\]/);
    assert.doesNotMatch(result, /was restarted 3 times|refund was not confirmed/);
  }
  const thread = await cardd.thread(1);
  assert.equal(
    thread.entries.filter((entry) => entry.fields["restartFailed"] !== undefined).length,
    4,
  );
});

test("a restart that finds a foreign Pi in the fresh pane before any start command is refunded", async () => {
  const dir = tempDir("start-foreign-shell-");
  const armed = join(dir, "armed");
  parts = await startDispatchLab({
    hosts: { far: ["node", READINESS, armed] },
    roots: { far: CHECKOUT },
  });
  const { cardd, h, mate } = parts;
  const restart = { tool: "restart_card", args: { card: 1 } };
  const arm = (): typeof restart => {
    writeFileSync(armed, "foreign-shell\n");
    rmSync(`${armed}.closed`, { force: true });
    return restart;
  };
  h.onModel(() => DISPATCH, "mate");
  h.onModel(async () => {
    await workerHelloAdopted(cardd, "c-1-a1");
    return arm();
  }, "mate");
  for (let tried = 1; tried < 4; tried += 1) h.onModel(arm, "mate");
  h.onModel(() => ({ text: "refused" }), "mate");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  const results = toolResults(await h.waitForCall(5, "mate", 4 * WORKER_WAIT_MS));
  assert.match(results.at(-5) ?? "", /^Dispatched c-1-a1 on far/);
  for (const result of results.slice(-4)) {
    assert.match(result, /did not become idle/);
    assert.doesNotMatch(result, /was restarted 3 times|refund was not confirmed/);
  }
  assert.equal(existsSync(`${armed}.starts`), false);
  const thread = await cardd.thread(1);
  assert.equal(
    thread.entries.filter((entry) => entry.fields["restartFailed"] !== undefined).length,
    4,
  );
});

test("a refunded restart leaves the worker's model pin as it was, so the same key retried without a model launches the pinned model", async () => {
  const dir = tempDir("start-refund-pin-");
  const armed = join(dir, "armed");
  parts = await startDispatchLab({
    hosts: { far: ["node", READINESS, armed] },
    roots: { far: CHECKOUT },
  });
  const { cardd, h, mate } = parts;
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  writeFileSync(
    join(h.dir, "agent", "models.json"),
    JSON.stringify({ providers: { tier: { apiKey: "scripted" } } }),
  );
  const pinned = "openai-codex/gpt-fixture";
  h.onModel(() => ({ ...DISPATCH, args: { ...DISPATCH.args, model: pinned } }), "mate");
  h.onModel(async () => {
    await workerHelloAdopted(cardd, "c-1-a1");
    writeFileSync(armed, "foreign-shell\n");
    rmSync(`${armed}.closed`, { force: true });
    return { tool: "restart_card", args: { card: 1, key: "K", model: "tier/quick" } };
  }, "mate");
  h.onModel(() => ({ tool: "board", args: { card: 1 } }), "mate");
  h.onModel(
    () => ({ tool: "run_long", args: { label: "wait0", command: "sleep 600" } }),
    "worker",
  );
  h.onModel(() => ({ text: "waiting for the job" }), "worker");
  const before = { generation: 0, calls: 0 };
  h.onModel(() => {
    rmSync(armed, { force: true });
    before.generation = sessionGeneration(cardd, "c-1-a1");
    before.calls = h.modelsOf("worker").length;
    return { tool: "restart_card", args: { card: 1, key: "K" } };
  }, "mate");
  h.onModel(async () => {
    await poll(
      () => (sessionGeneration(cardd, "c-1-a1") > before.generation ? true : undefined),
      "the replacement worker to connect",
      WORKER_WAIT_MS,
    );
    await h.waitForCall(before.calls, "worker", WORKER_WAIT_MS);
    return { tool: "board", args: { card: 1 } };
  }, "mate");
  h.onModel(() => ({ text: "done" }), "mate");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  const results = toolResults(await h.waitForCall(5, "mate", 4 * WORKER_WAIT_MS));
  assert.match(results.at(-4) ?? "", /did not become idle/);
  assert.match(results.at(-3) ?? "", /,openai-codex\/gpt-fixture$/m);
  assert.match(results.at(-2) ?? "", /^Started c-1-a1 again on far, /);
  assert.doesNotMatch(results.at(-2) ?? "", /already recorded|did not become idle|restarted 3 times/);
  const replacement = h.modelsOf("worker").slice(before.calls);
  assert.ok(replacement.length > 0);
  for (const model of replacement) assert.equal(model, pinned);
});

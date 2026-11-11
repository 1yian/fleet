import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  avoidSeenOf,
  launchArgsOf,
  mateConnected as connected,
  toolResults,
  startDispatchLab,
  stopDispatchLab,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import type { Move } from "../support/harness.ts";

let parts: DispatchLab;
beforeEach(async () => {
  parts = await startDispatchLab();
});
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

const seen = (): string[] => {
  const file = avoidSeenOf(parts.h);
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
    : [];
};

async function seenCount(count: number): Promise<string[]> {
  const deadline = Date.now() + WORKER_WAIT_MS;
  while (seen().length < count) {
    assert.ok(Date.now() < deadline, `only ${String(seen().length)} worker starts were seen`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return seen();
}

test("a restart with avoid starts the worker's Pi with PI_TIERS_AVOID, and a plain restart clears it", async () => {
  const { h, mate } = parts;
  const asks: Record<string, readonly Move[]> = {
    "ship the scrollbar fix": [
      { tool: "board", args: {} },
      {
        tool: "dispatch",
        args: {
          title: "Users see one scrollbar",
          name: "one-scrollbar",
          kind: "ship",
          project: "site",
          intent: "Fix the scrollbar",
          host: "local",
          task: "fix the scrollbar",
        },
      },
      { text: "dispatched" },
    ],
    "restart it, avoiding claude-max and openai": [
      { tool: "restart_card", args: { card: 1, key: "a", avoid: ["claude-max", "openai"] } },
      { text: "restarted avoiding" },
    ],
    "restart it again": [
      { tool: "restart_card", args: { card: 1, key: "b" } },
      { text: "restarted plain" },
    ],
  };
  for (let call = 0; call < 40; call += 1)
    h.onModel((turns) => {
      const at = turns.findLastIndex((turn) => turn.role === "user" && turn.text in asks);
      const done = turns.slice(at).filter((turn) => turn.role === "toolResult").length;
      return asks[turns[at]?.text ?? ""]?.[done] ?? { text: "noted" };
    }, "mate");
  for (let turn = 0; turn < 3; turn += 1) {
    h.onModel(
      () => ({ tool: "run_long", args: { label: `wait${String(turn)}`, command: "sleep 600" } }),
      "worker",
    );
    h.onModel(() => ({ text: "waiting for the job" }), "worker");
  }
  await connected(h);
  mate.prompt("ship the scrollbar fix");
  assert.deepEqual(await seenCount(1), ["(unset)"]);

  await h.waitForCall(2, "mate", WORKER_WAIT_MS);
  mate.prompt("restart it, avoiding claude-max and openai");
  assert.deepEqual(await seenCount(2), ["(unset)", "claude-max,openai"]);

  await h.waitForCall(4, "mate", WORKER_WAIT_MS);
  mate.prompt("restart it again");
  assert.deepEqual(await seenCount(3), ["(unset)", "claude-max,openai", "(unset)"]);
});

test("a restart cannot avoid the provider of the worker's explicit GPT model, leaves the worker running, and a permitted restart keeps the model", async () => {
  const { h, mate } = parts;
  const model = "openai-codex/gpt-fixture";
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Users see Spanish copy",
        name: "spanish-copy",
        kind: "ship",
        project: "site",
        intent: "Review the Spanish copy",
        host: "local",
        task: "review the Spanish product copy",
        model,
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({
      tool: "restart_card",
      args: { card: 1, key: "a", avoid: ["claude-max", "openai-codex"] },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "refused" }), "mate");
  h.onModel(
    () => ({ tool: "restart_card", args: { card: 1, key: "b", avoid: ["claude-max"] } }),
    "mate",
  );
  h.onModel(() => ({ text: "restarted avoiding claude-max" }), "mate");
  for (let turn = 0; turn < 3; turn += 1) {
    h.onModel(
      () => ({ tool: "run_long", args: { label: `wait${String(turn)}`, command: "sleep 600" } }),
      "worker",
    );
    h.onModel(() => ({ text: "waiting for the job" }), "worker");
  }
  await connected(h);
  mate.prompt("ship the Spanish copy review");
  assert.deepEqual(await seenCount(1), ["(unset)"]);

  await h.waitForCall(2, "mate", WORKER_WAIT_MS);
  mate.prompt("restart it, avoiding claude-max and openai-codex");
  const refusal = await h.waitForCall(4, "mate", WORKER_WAIT_MS);
  assert.match(refusal.at(-1)?.text ?? "", /cannot avoid openai-codex/);
  assert.deepEqual(seen(), ["(unset)"]);

  mate.prompt("restart it, avoiding only claude-max");
  assert.deepEqual(await seenCount(2), ["(unset)", "claude-max"]);
  await h.waitForCall(1, "worker", WORKER_WAIT_MS);
  assert.ok(h.modelsOf("worker").length >= 2);
  for (const each of h.modelsOf("worker")) assert.equal(each, model);
});

test("the card's own mate re-pins an explicit-model worker to the router with restart_card, and the worker keeps its card, conversation, and branch", async () => {
  const { h, mate, clone } = parts;
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  writeFileSync(
    join(h.dir, "agent", "models.json"),
    JSON.stringify({ providers: { tier: { apiKey: "scripted" } } }),
  );
  const pinned = "openai-codex/gpt-fixture";
  const task = "build the iOS onboarding screens";
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Onboarding screens",
        name: "ios-onboarding",
        kind: "ship",
        project: "site",
        intent: "Build the onboarding screens",
        host: "local",
        task,
        model: pinned,
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(
    () => ({ tool: "restart_card", args: { card: 1, key: "a", model: "tier/quick" } }),
    "mate",
  );
  h.onModel(() => ({ tool: "board", args: { card: 1 } }), "mate");
  h.onModel(() => ({ text: "re-pinned" }), "mate");
  for (let turn = 0; turn < 3; turn += 1) {
    h.onModel(
      () => ({ tool: "run_long", args: { label: `wait${String(turn)}`, command: "sleep 600" } }),
      "worker",
    );
    h.onModel(() => ({ text: "waiting for the job" }), "worker");
  }
  const workerRuns = (): number => h.modelsOf("worker").length;
  const nextWorkerCall = async (): Promise<void> => {
    await h.waitForCall(workerRuns(), "worker", WORKER_WAIT_MS);
  };
  const launchedWith = (): string => readFileSync(launchArgsOf(h), "utf8");
  await connected(h);

  mate.prompt("ship the onboarding screens");
  await seenCount(1);
  await h.waitForCall(0, "worker", WORKER_WAIT_MS);
  assert.equal(h.modelsOf("worker").at(0), pinned);
  assert.match(launchedWith(), new RegExp(`--model\\n${pinned}\\n`));

  await h.waitForCall(2, "mate", WORKER_WAIT_MS);
  mate.prompt("move the onboarding worker to the quick tier");
  await seenCount(2);
  while (h.modelsOf("worker").at(-1) !== "tier/quick") await nextWorkerCall();
  assert.match(launchedWith(), /--model\ntier\/quick\n/);
  assert.match(launchedWith(), /--session-id\nc-1-a1\n/);
  const resumed = h.callsOf("worker").at(-1) ?? [];
  assert.ok(
    resumed.some((turn) => turn.role === "user" && turn.text.includes(task)),
    "the restarted worker has its first task message in its conversation",
  );
  const view = await h.waitForCall(5, "mate", WORKER_WAIT_MS);
  assert.match(toolResults(view).join("\n"), /active,c-1-a1,tier\/quick/);
  assert.deepEqual(
    execFileSync("git", ["-C", clone, "branch", "--format=%(refname:short)"], { encoding: "utf8" })
      .split("\n")
      .filter((name) => name.endsWith("c-1-a1")),
    ["c-1-a1"],
  );
});

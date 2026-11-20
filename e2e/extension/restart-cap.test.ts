import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { check, HttpOutcomeSchema, OPS } from "@fleet/protocol";
import { gate, poll } from "../support/harness.ts";
import {
  mateConnected,
  plan,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workerGroupOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { tempDir } from "../support/run-root.ts";

const READINESS = fileURLToPath(new URL("../support/readiness-transport.ts", import.meta.url));
const CHECKOUT = fileURLToPath(new URL("../..", import.meta.url));
const RESTART_NOTICE = "Your session was restarted on the same card and conversation.";
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

test("a restart whose process could not be started never counts toward the hourly cap, so the mate can try again", async (t) => {
  const inFlight = gate();
  t.after(inFlight.open);
  parts = await startDispatchLab();
  const { h, mate, cardd } = parts;
  const down = join(h.dir, "far-down");
  const restart = { tool: "restart_card", args: { card: 1 } };
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => DISPATCH, "mate");
  h.onModel(() => {
    writeFileSync(down, "down\n");
    return restart;
  }, "mate");
  for (let failing = 0; failing < 3; failing += 1) h.onModel(() => restart, "mate");
  h.onModel(async () => {
    await h.waitForCall(0, "worker", WORKER_WAIT_MS);
    rmSync(down);
    return restart;
  }, "mate");
  h.onModel(() => ({ text: "restarted" }), "mate");
  h.onModel(async () => {
    await inFlight.wait;
    return { text: "working" };
  }, "worker");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix");

  const results = toolResults(await h.waitForCall(7, "mate", WORKER_WAIT_MS));
  assert.match(results.at(-6) ?? "", /^Dispatched c-1-a1 on far/);
  for (const refused of results.slice(-5, -1)) {
    assert.match(refused, /Operation timed out/);
    assert.doesNotMatch(refused, /was restarted 3 times/);
  }
  assert.match(results.at(-1) ?? "", /^Started c-1-a1 again on far/);
  const carriesNotice = (turns: readonly { text: string }[]): boolean =>
    turns.some((turn) => turn.text.includes(RESTART_NOTICE));
  await poll(
    () => h.callsOf("worker").find(carriesNotice),
    "the restarted worker's turn with the restart notice",
    WORKER_WAIT_MS,
  );
  const thread = await cardd.thread(1);
  assert.equal(
    thread.entries.filter((entry) => entry.fields["restartFailed"] !== undefined).length,
    4,
  );
});

test("the mate sees the launch error and cap warning when cardd cannot record the refund", async () => {
  parts = await startDispatchLab();
  const { cardd, h, mate } = parts;
  const db = new DatabaseSync(cardd.db, { timeout: 5000 });
  try {
    db.exec(`CREATE TRIGGER refuse_refund BEFORE INSERT ON entries
      WHEN NEW.kind = 'note' AND json_extract(NEW.fields, '$.restartFailed') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'refund cannot be recorded'); END`);
  } finally {
    db.close();
  }
  for (let call = 0; call < 8; call += 1) {
    h.onModel(
      (turns) =>
        plan(turns, {
          "ship the scrollbar fix": [DISPATCH],
          "restart with the host offline": [{ tool: "restart_card", args: { card: 1 } }],
        }),
      "mate",
    );
  }
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix", "followUp");
  await poll(
    () =>
      h
        .callsOf("mate")
        .flatMap(toolResults)
        .find((text) => text.startsWith("Dispatched c-1-a1")),
    "the completed dispatch",
    WORKER_WAIT_MS,
  );
  writeFileSync(join(h.dir, "far-down"), "down\n");
  mate.prompt("restart with the host offline", "followUp");
  const result = await poll(
    () =>
      h
        .callsOf("mate")
        .flatMap(toolResults)
        .find((text) => text.includes("Operation timed out")),
    "the failed restart tool result",
    WORKER_WAIT_MS,
  );
  assert.match(
    result,
    /The restart refund was not confirmed; this request may still count toward the hourly cap\./,
  );
});

async function verifyCountedRestart({ cardd, mainToken }: DispatchLab, key: string): Promise<void> {
  const restart = { card: 1, key, mode: "replace" } as const;
  const thread = await cardd.thread(1);
  const request = thread.entries.find((entry) => entry.fields["restartKey"] === key);
  assert.ok(request);
  const refund = await cardd.post(mainToken, "card.restart.failed", {
    card: 1,
    key,
    request: request.id,
  });
  assert.deepEqual(refund.body, { ok: true, value: { recorded: false } });
  const post = async (key: string) =>
    check(
      HttpOutcomeSchema,
      (await cardd.post(mainToken, "card.restart", { ...restart, key })).body,
    );
  const repeated = await post(key);
  assert.ok(repeated.ok, repeated.ok ? undefined : repeated.error);
  const replay = check(OPS["card.restart"].result, repeated.value);
  assert.deepEqual([replay.repeat, replay.generation], [true, 2]);
  for (const nextKey of ["second-slot", "third-slot"]) {
    const next = await post(nextKey);
    assert.ok(next.ok, next.ok ? undefined : next.error);
    assert.equal(check(OPS["card.restart"].result, next.value).repeat, false);
  }
  assert.deepEqual(await post("fourth-slot"), {
    ok: false,
    error: "c-1 was restarted 3 times in the last hour",
  });
}

test("a real replacement that connects and exits before readiness is not launched again or refunded", async (t) => {
  const armed = join(tempDir("readiness-failure-"), "armed");
  const released = `${armed}.released`;
  t.after(() => {
    writeFileSync(released, "release\n");
  });
  const inFlight = gate();
  t.after(inFlight.open);
  parts = await startDispatchLab({
    hosts: { far: ["node", READINESS, armed] },
    roots: { far: CHECKOUT },
  });
  const { cardd, mainToken, h, lab, mate } = parts;
  const restart = { card: 1, key: "readiness", mode: "replace" } as const;
  const results = () => h.callsOf("mate").flatMap(toolResults);
  for (let call = 0; call < 12; call += 1) {
    h.onModel(
      (turns) =>
        plan(turns, {
          "ship the scrollbar fix": [DISPATCH],
          "restart after dispatch": [{ tool: "restart_card", args: restart }],
        }),
      "mate",
    );
  }
  h.onModel(async () => {
    await inFlight.wait;
    return { text: "working" };
  }, "worker");
  await mateConnected(h);
  mate.prompt("ship the scrollbar fix", "followUp");
  await poll(
    () => results().find((text) => text.startsWith("Dispatched c-1-a1")),
    "dispatch",
    WORKER_WAIT_MS,
  );
  await h.waitForCall(0, "worker", WORKER_WAIT_MS);
  writeFileSync(armed, "armed\n");
  mate.prompt("restart after dispatch", "followUp");
  const deadline = Date.now() + WORKER_WAIT_MS;
  for (;;) {
    const response = await cardd.post(mainToken, "attempt.resume", { card: 1 });
    const resumed = check(HttpOutcomeSchema, response.body);
    assert.ok(resumed.ok, resumed.ok ? undefined : resumed.error);
    if (check(OPS["attempt.resume"].result, resumed.value).generation === 2) break;
    assert.ok(Date.now() < deadline, "cardd did not record the replacement's hello");
    await delay(20);
  }
  const group = await workerGroupOf(lab, "c-1-a1");
  assert.ok(group !== undefined && group > 0);
  process.kill(-group, "SIGKILL");
  await cardd.waitForSessionLost("c-1-a1");
  while ((await workerGroupOf(lab, "c-1-a1")) !== undefined) {
    assert.ok(Date.now() < deadline, "the replacement is still in the pane");
    await delay(20);
  }
  writeFileSync(released, "release\n");

  const result = await poll(
    () =>
      results().find((text) =>
        /worker readiness confirmation failed|^Started c-1-a1 again/.test(text),
      ),
    "the replacement's readiness result",
    WORKER_WAIT_MS,
  );
  assert.match(result, /worker readiness confirmation failed/);
  assert.match(result, /The replacement connected before readiness failed/);
  assert.equal(readFileSync(`${armed}.starts`, "utf8"), "start\n");

  await verifyCountedRestart(parts, restart.key);
});

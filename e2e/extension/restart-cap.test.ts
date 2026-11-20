import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { check, HttpOutcomeSchema, OPS } from "@fleet/protocol";
import { gate, poll } from "../support/harness.ts";
import {
  launchArgsOf,
  mateConnected,
  plan,
  RESTART_REPEATED,
  restartRepeatFinished,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workerGroupOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { gateOf } from "../support/hold-start.ts";
import { tempDir } from "../support/run-root.ts";

const READINESS = fileURLToPath(new URL("../support/readiness-transport.ts", import.meta.url));
const CHECKOUT = fileURLToPath(new URL("../..", import.meta.url));
const HOLD = fileURLToPath(new URL("../support/hold-start.ts", import.meta.url));
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

test("a failed refund shows both the idle pane context and the scrubbed refusal to the mate only", async () => {
  const armed = join(tempDir("start-refused-"), "armed");
  parts = await startDispatchLab({
    hosts: { far: ["node", READINESS, armed] },
    roots: { far: CHECKOUT },
  });
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
          "restart after dispatch": [{ tool: "restart_card", args: { card: 1 } }],
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
  writeFileSync(armed, "refuse\n");
  mate.prompt("restart after dispatch", "followUp");
  const result = await poll(
    () =>
      h
        .callsOf("mate")
        .flatMap(toolResults)
        .find((text) => text.includes("The restart refund was not confirmed")),
    "the failed restart tool result",
    WORKER_WAIT_MS,
  );
  assert.match(result, /Pi is not running in pane/);
  assert.match(result, /fixture refused the start --fleet-token \[hidden\]/);
  assert.doesNotMatch(result, /fixture-secret/);
  assert.match(
    result,
    /The restart refund was not confirmed; this request may still count toward the hourly cap\./,
  );
  const thread = await cardd.thread(1);
  assert.ok(thread.entries.every((entry) => !entry.body.includes("fixture refused the start")));
});

async function verifyCountedRestart(
  { cardd, mainToken }: DispatchLab,
  key: string,
  generation: number,
): Promise<void> {
  const restart = { card: 1, key, mode: "replace" } as const;
  const thread = await cardd.thread(1);
  const request = thread.entries.find((entry) => entry.fields["restartKey"] === key);
  assert.ok(request);
  assert.ok(thread.entries.every((entry) => entry.fields["restartFailed"] !== request.id));
  if (generation === 2) {
    const refund = await cardd.post(mainToken, "card.restart.failed", {
      card: 1,
      key,
      request: request.id,
    });
    assert.deepEqual(refund.body, { ok: true, value: { recorded: false } });
  }
  const post = async (key: string) =>
    check(
      HttpOutcomeSchema,
      (await cardd.post(mainToken, "card.restart", { ...restart, key })).body,
    );
  const repeated = await post(key);
  assert.ok(repeated.ok, repeated.ok ? undefined : repeated.error);
  const replay = check(OPS["card.restart"].result, repeated.value);
  assert.deepEqual([replay.repeat, replay.generation], [true, generation]);
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

async function generationOf({ cardd, mainToken }: DispatchLab): Promise<number> {
  const { body } = await cardd.post(mainToken, "attempt.resume", { card: 1 });
  const resumed = check(HttpOutcomeSchema, body);
  assert.ok(resumed.ok, resumed.ok ? undefined : resumed.error);
  return check(OPS["attempt.resume"].result, resumed.value).generation;
}

async function stopReplacement(
  lab: DispatchLab,
  original: number,
  generation: number,
): Promise<void> {
  const attempt = "c-1-a1";
  const deadline = Date.now() + WORKER_WAIT_MS;
  for (;;) {
    const group = await workerGroupOf(lab.lab, attempt);
    if (
      group !== undefined &&
      group > 0 &&
      group !== original &&
      (await generationOf(lab)) === generation
    ) {
      process.kill(-group, "SIGKILL");
      break;
    }
    assert.ok(
      Date.now() < deadline,
      `the replacement did not start at generation ${String(generation)}`,
    );
    await delay(20);
  }
}

async function stopReplacement(lab: DispatchLab, group: number, connected: boolean): Promise<void> {
  const attempt = "c-1-a1";
  const deadline = Date.now() + WORKER_WAIT_MS;
  process.kill(-group, "SIGKILL");
  if (connected) await lab.cardd.waitForSessionLost(attempt);
  while ((await workerGroupOf(lab.lab, attempt)) !== undefined) {
    assert.ok(Date.now() < deadline, "the replacement is still in the pane");
    await delay(20);
  }
}

async function waitForRestartNotice({ h }: DispatchLab): Promise<void> {
  const carriesNotice = (turns: readonly { text: string }[]): boolean =>
    turns.some((turn) => turn.text.includes(RESTART_NOTICE));
  await poll(
    () => h.callsOf("worker").find(carriesNotice),
    "the replacement to receive the notice before readiness returns",
    WORKER_WAIT_MS,
  );
}

function mateResultsAfter({ h }: DispatchLab, prompt: string): string[] | undefined {
  return h.callsOf("mate").flatMap((turns) => {
    const at = turns.findLastIndex((turn) => turn.role === "user");
    const results = toolResults(turns.slice(at + 1));
    return turns[at]?.text === prompt && results.length === 2 ? [results] : [];
  })[0];
}

const CONFIRMED =
  /^Started c-1-a1 again on far[^\n]*\. The replacement connected to Fleet, but Herdr did not confirm interactive readiness; the restart still counts and was not relaunched\. Herdr reported:\n/;
const UNCONFIRMED =
  /The replacement could not be confirmed after the start command; the request was not refunded/;
const REFUSED = /fixture refused the start --fleet-token \[hidden\]/;
const CONTAINMENT_FAILED =
  /fixture containment failed --fleet-token \[hidden\]\nHerdr also reported:\nherdr agent on far failed: worker readiness/;
const TIMEOUT = /"code":"timeout","message":"timed out waiting for agent startup"/;

interface Readiness {
  readonly mode: "before" | "after" | "visible" | "refuse-late" | "contain-fail";
  readonly situation: string;
  readonly foreign: boolean;
  readonly generation: number;
  readonly result: RegExp;
}

const readinessCases: readonly Readiness[] = [
  {
    mode: "before",
    situation: "exits before hello",
    foreign: false,
    generation: 1,
    result: UNCONFIRMED,
  },
  {
    mode: "before",
    situation: "exits before hello after another process of the session connected",
    foreign: true,
    generation: 2,
    result: UNCONFIRMED,
  },
  {
    mode: "refuse-late",
    situation: "is refused after another process of the session connected",
    foreign: true,
    generation: 2,
    result: REFUSED,
  },
  {
    mode: "after",
    situation: "exits after hello",
    foreign: false,
    generation: 2,
    result: CONFIRMED,
  },
  {
    mode: "contain-fail",
    situation: "connects but cannot be contained",
    foreign: false,
    generation: 2,
    result: CONTAINMENT_FAILED,
  },
  {
    mode: "visible",
    situation: "is visible before the command returns",
    foreign: false,
    generation: 2,
    result: CONFIRMED,
  },
];

const argvValue = (h: DispatchLab["h"], prefix: string): string => {
  const found = readFileSync(launchArgsOf(h), "utf8")
    .split("\n")
    .find((arg) => arg.startsWith(prefix));
  assert.ok(found !== undefined, `the launch carried ${prefix}`);
  return found.slice(prefix.length);
};

function sessionProcess({ cardd }: DispatchLab): string | null {
  const db = new DatabaseSync(cardd.db, { readOnly: true, timeout: 5000 });
  try {
    const process = db.prepare("SELECT process FROM sessions WHERE id = 'c-1-a1'").get()?.[
      "process"
    ];
    return typeof process === "string" ? process : null;
  } finally {
    db.close();
  }
}

async function anotherProcessConnects(lab: DispatchLab, token: string): Promise<void> {
  const other = await lab.cardd.connect(token, [], false);
  await other.close();
  assert.equal(await generationOf(lab), 2);
}

async function reachBarrier(
  lab: DispatchLab,
  { mode, foreign }: Readiness,
  armed: string,
  original: number,
): Promise<void> {
  const token = argvValue(lab.h, "--fleet-token=");
  if (mode === "refuse-late") {
    await poll(
      () => (existsSync(`${armed}.starts`) ? true : undefined),
      "the refused start command to be issued",
      WORKER_WAIT_MS,
    );
    await anotherProcessConnects(lab, token);
    return;
  }
  const group = await replacementGroup(lab, original, mode === "before" ? 1 : 2);
  if (foreign) await anotherProcessConnects(lab, token);
  if (mode === "visible" || mode === "contain-fail") {
    await waitForRestartNotice(lab);
    assert.equal(await workerGroupOf(lab.lab, "c-1-a1"), group);
  } else await stopReplacement(lab, group, mode === "after");
}

async function repeatCompletesWhileGated(lab: DispatchLab, prompt: string): Promise<void> {
  await restartRepeatFinished(lab.h);
  assert.equal(mateResultsAfter(lab, prompt), undefined);
}

async function assertLaunchLost(lab: DispatchLab): Promise<void> {
  const text = await poll(
    () =>
      lab.h
        .callsOf("mate")
        .flatMap((turns) => turns.filter((turn) => turn.role === "user"))
        .find(
          (turn) =>
            turn.text.includes("[fleet] launch:") && turn.text.includes("connected to Fleet"),
        )?.text,
    "the report that the connected replacement exited",
    WORKER_WAIT_MS,
  );
  assert.match(text, /Pi is not running in pane \S+ on far after c-1-a1 connected to Fleet\./);
  assert.doesNotMatch(text, /never connected/);
}

function assertOutcome(lab: DispatchLab, c: Readiness, armed: string, result: string): void {
  assert.doesNotMatch(result, /fixture-secret/);
  assert.match(result, c.result);
  const launched = readFileSync(`${armed}.launched`, "utf8").trim();
  assert.match(launched, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  if (c.result === CONFIRMED) {
    assert.equal(argvValue(lab.h, "--fleet-process="), launched);
    assert.match(result, /worker readiness confirmation failed --fleet-token \[hidden\]/);
    assert.match(result, TIMEOUT);
    assert.equal(sessionProcess(lab), launched);
    return;
  }
  assert.doesNotMatch(result, /^Started c-1-a1 again|interactive readiness/);
  if (c.mode === "contain-fail") {
    assert.match(result, TIMEOUT);
    assert.equal(sessionProcess(lab), launched);
    return;
  }
  if (c.mode === "refuse-late") assert.match(result, /refund was not confirmed/);
  else assert.match(result, /worker readiness confirmation failed --fleet-token \[hidden\]/);
  assert.notEqual(sessionProcess(lab), launched);
}

for (const c of readinessCases) {
  test(`a replacement that ${c.situation} is reported as ${c.result === CONFIRMED ? "launched with Herdr's readiness failure separate" : "failed"} and stays counted`, async (t) => {
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
      workerArgs: ["-e", HOLD],
    });
    const { h, lab, mate } = parts;
    const restart = { card: 1, key: "readiness", mode: "replace" } as const;
    const restartMove = { tool: "restart_card", args: restart };
    const restartPrompt = "restart after dispatch";
    const results = () => h.callsOf("mate").flatMap(toolResults);
    for (let call = 0; call < 12; call += 1) {
      h.onModel(
        (turns) =>
          plan(turns, {
            "ship the scrollbar fix": [DISPATCH],
            [restartPrompt]: [{ ...restartMove, alongside: [restartMove] }],
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
    const original = await workerGroupOf(lab, "c-1-a1");
    assert.ok(original !== undefined && original > 0);
    if (c.mode === "before") execFileSync("sh", ["-c", 'mkfifo "$0"', gateOf(launchArgsOf(h))]);
    writeFileSync(armed, c.mode);
    mate.prompt(restartPrompt, "followUp");
    await reachBarrier(parts, c, armed, original);
    await repeatCompletesWhileGated(parts, restartPrompt);
    assert.equal(readFileSync(`${armed}.starts`, "utf8"), "start\n");
    writeFileSync(released, "release\n");

    const both = await poll(
      () => mateResultsAfter(parts, restartPrompt),
      "the mate's results for the restart and its same-key call",
      WORKER_WAIT_MS,
    );
    assert.equal(both.filter((text) => text === RESTART_REPEATED).length, 1);
    const [result] = both.filter((text) => text !== RESTART_REPEATED);
    assert.ok(result !== undefined);
    assertOutcome(parts, c, armed, result);
    assert.equal(readFileSync(`${armed}.starts`, "utf8"), "start\n");
    if (c.mode === "after") await assertLaunchLost(parts);

    await verifyCountedRestart(parts, restart.key, c.generation);
  });
}

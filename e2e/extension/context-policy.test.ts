import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { WireCall } from "../support/anthropic-wire.ts";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch, settingsArgs, startMain } from "../support/scratch.ts";

const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const SUPPORT = new URL("../support/", import.meta.url);
const FAKE_MODEL = fileURLToPath(new URL("fake-model.ts", SUPPORT));
const FAKE_ANTHROPIC = fileURLToPath(new URL("fake-anthropic.ts", SUPPORT));
const PROBE = fileURLToPath(new URL("probe.ts", SUPPORT));

const BELOW_COMPACTION = 390_000;
const ABOVE_COMPACTION = 410_000;
const BELOW_SMALL_COMPACTION = 150_000;
const ABOVE_SMALL_COMPACTION = 170_000;
const MATE_COMPACTION = 330_000;
const MATE_BELOW_BLOCK = 335_000;
const MATE_OVER_LIMIT = 410_000;
const LONG_CONVERSATION = "x".repeat(200_000);

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let cleo: Session;
let mainToken: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  mainToken = cardd.addLane("main", undefined, scratch.root);
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  cardd.addProject("fleet", { local: scratch.root });
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  writeFileSync(
    join(h.dir, "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "tier", defaultModel: "auto" }),
  );
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    FLEET_COMPACTION_RETRY_MS: "200",
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
  });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([cleo.close(), lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

function wireArgs(): string[] {
  const args = settingsArgs(h);
  const at = args.indexOf(FAKE_MODEL);
  return [...args.slice(0, at - 1), ...args.slice(at + 1), "-e", FAKE_ANTHROPIC];
}

const isCompaction = (call: WireCall): boolean =>
  call.turns.some(
    (turn) => turn.role === "system" && turn.text.includes("context summarization assistant"),
  );
const askedByWorker = (call: WireCall): boolean => call.role === "worker" && !call.warm;
const askedByMate = (call: WireCall): boolean =>
  call.role === "mate" && !call.warm && !isCompaction(call);

async function runWorker(model: string, first: number, second: number): Promise<WireCall> {
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => {
    return {
      tool: "dispatch",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "fleet",
        intent: "Fix the scrollbar",
        host: "local",
        task: "fix the scrollbar",
      },
    };
  }, "mate");
  h.onModel(
    () => ({ tool: "slow_tool", args: { notes: LONG_CONVERSATION }, promptTokens: first }),
    "worker",
  );
  h.onModel(() => ({ text: "done", promptTokens: second }), "worker");
  configureMain(scratch, cardd.url, mainToken, {
    workerArgs: [...wireArgs(), "--model", `tier/${model}`, "-e", PROBE],
  });
  await startMain(lab, scratch, h, false, wireArgs());
  const asked: unknown = await cleo.call("card.new", { title: "Ship the fix", kind: "scout" });
  await cleo.call("hold", {
    card: Number(Reflect.get(Object(asked), "id")),
    question: "Ship the fix?",
    options: ["Yes"],
  });

  await h.waitFor((event) => event["type"] === "tool_waiting", "the worker to wait in its tool");
  h.releaseTool();
  const compaction = await h.waitForWire(isCompaction, "the worker's session to compact");
  return compaction;
}

const workerCallsBefore = (compaction: WireCall): number =>
  h.wire.slice(0, h.wire.indexOf(compaction)).filter(askedByWorker).length;

test("a worker on a routed 1M model compacts at 400K of its 500K limit", async () => {
  const compaction = await runWorker("routed", BELOW_COMPACTION, ABOVE_COMPACTION);

  assert.equal(workerCallsBefore(compaction), 2);
});

test("a worker on a 200K model compacts at 160K, before its own limit, and is never told it has 500K", async () => {
  const compaction = await runWorker("small", BELOW_SMALL_COMPACTION, ABOVE_SMALL_COMPACTION);

  assert.equal(workerCallsBefore(compaction), 2);
});

test("a worker whose tier routes from a 1M model to a 200K model compacts on the second model's 160K", async () => {
  const compaction = await runWorker("swing", ABOVE_SMALL_COMPACTION, ABOVE_SMALL_COMPACTION);

  assert.equal(workerCallsBefore(compaction), 1);
});

const COMPACTOR_DOWN = "pi-tiers: no usable model for tier 'compact'";

let compactorDown: boolean;
let mateTokens: number;

function scriptMate(): void {
  compactorDown = true;
  for (let call = 0; call < 80; call += 1)
    h.onModel((turns) => {
      const summarizing = turns.some(
        (turn) => turn.role === "system" && turn.text.includes("context summarization assistant"),
      );
      if (summarizing) return compactorDown ? { fail: COMPACTOR_DOWN } : { text: "summary" };
      return { text: "reply", promptTokens: mateTokens };
    }, "mate");
}

async function startMate(): Promise<void> {
  configureMain(scratch, cardd.url, mainToken);
  await startMain(lab, scratch, h, false, wireArgs());
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to join the fleet");
}

const settledRuns = (): number =>
  h.events.filter((event) => event["type"] === "settled" && event["aborted"] === false).length;

async function turnThatEnds(id: number, text: string): Promise<void> {
  const before = settledRuns();
  h.send(id, "followUp", text);
  await h.waitForNth(
    (event) => event["type"] === "settled" && event["aborted"] === false,
    before + 1,
    `the mate's turn on ${text.slice(0, 20)}`,
  );
}

const blockedEvents = (): Record<string, unknown>[] =>
  h.events.filter((event) => event["type"] === "blocked");

async function overLimitAndBlocked(): Promise<void> {
  scriptMate();
  mateTokens = MATE_OVER_LIMIT;
  await startMate();
  await turnThatEnds(1, `first ${LONG_CONVERSATION}`);
  await turnThatEnds(2, `second ${LONG_CONVERSATION}`);
  await h.waitForWire(isCompaction, "the mate's compaction attempt");
  h.send(3, "followUp", `third ${LONG_CONVERSATION}`);
  await h.waitFor(
    (event) =>
      event["type"] === "blocked" && String(event["label"]).startsWith("blocked: context over"),
    "the mate to read blocked",
  );
}

test("a mate under 400K keeps working while its compaction is down", async () => {
  scriptMate();
  mateTokens = MATE_BELOW_BLOCK;
  await startMate();

  await turnThatEnds(1, `first ${LONG_CONVERSATION}`);
  await turnThatEnds(2, `second ${LONG_CONVERSATION}`);
  await h.waitForWire(isCompaction, "the mate's compaction attempt");
  h.send(3, "followUp", `third ${LONG_CONVERSATION}`);
  await h.waitForWire(
    (call) => askedByMate(call) && call.turns.some((turn) => turn.text.includes("third ")),
    "the mate's request to go out",
  );

  assert.equal(h.wire.filter(askedByMate).length, 3);
  assert.deepEqual(
    blockedEvents().filter((event) => String(event["label"]).startsWith("blocked: context over")),
    [],
  );
});

test("a mate over 400K with its compaction down refuses the request and reads blocked with the reason", async () => {
  await overLimitAndBlocked();

  const labels = blockedEvents().map((event) => event["label"]);
  assert.ok(labels.includes("blocked: context over 400K, waiting for compaction"), String(labels));
  assert.equal(h.wire.filter(askedByMate).length, 2);
});

test("a blocked mate resumes on its same conversation, with the pending input, after a compaction succeeds", async () => {
  await overLimitAndBlocked();
  const session = await h.waitFor((event) => event["type"] === "session", "the mate's session");
  mateTokens = MATE_COMPACTION;
  compactorDown = false;

  await h.waitFor(
    (event) => event["type"] === "blocked" && event["active"] === false,
    "the block to clear",
  );
  const resumed = await h.waitForWire(
    (call) => askedByMate(call) && call.turns.some((turn) => turn.text.includes("third ")),
    "the pending input to go out",
  );

  assert.ok(resumed.turns.some((turn) => turn.text.includes("first ") || turn.role === "system"));
  assert.equal(h.events.filter((event) => event["type"] === "session").length, 1);
  assert.equal(session["reason"], "startup");
});

test("a mate with 330K of context is compacted at 80% of its 400K limit", async () => {
  scriptMate();
  compactorDown = false;
  mateTokens = MATE_COMPACTION;
  await startMate();

  await turnThatEnds(1, `first ${LONG_CONVERSATION}`);
  await turnThatEnds(2, `second ${LONG_CONVERSATION}`);
  const compaction = await h.waitForWire(isCompaction, "the mate to compact");

  assert.equal(h.wire.slice(0, h.wire.indexOf(compaction)).filter(askedByMate).length, 2);
});

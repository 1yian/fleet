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

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const SUPPORT = new URL("../support/", import.meta.url);
const FAKE_MODEL = fileURLToPath(new URL("fake-model.ts", SUPPORT));
const FAKE_ANTHROPIC = fileURLToPath(new URL("fake-anthropic.ts", SUPPORT));
const PROBE = fileURLToPath(new URL("probe.ts", SUPPORT));

const BELOW_COMPACTION = 190_000;
const ABOVE_COMPACTION = 210_000;
const BELOW_WIDER_COMPACTION = 390_000;
const ABOVE_WIDER_COMPACTION = 410_000;
const BELOW_SMALL_COMPACTION = 150_000;
const ABOVE_SMALL_COMPACTION = 170_000;
const MATE_OVER_WORKER_LIMIT = 450_000;
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
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
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

async function runWorker(
  model: string,
  first: number,
  second: number,
  lane: Record<string, unknown> = {},
): Promise<WireCall> {
  h.onModel(
    () => ({
      tool: "card_new",
      args: {
        title: "Users see one scrollbar",
        name: "one-scrollbar",
        kind: "ship",
        project: "fleet",
      },
    }),
    "mate",
  );
  h.onModel((turns) => {
    const created = turns.findLast((turn) => turn.role === "toolResult")?.text ?? "";
    const card = Number(/c-(\d+)/.exec(created)?.[1]);
    return { tool: "dispatch", args: { card, host: "local", task: "fix the scrollbar" } };
  }, "mate");
  h.onModel(
    () => ({ tool: "slow_tool", args: { notes: LONG_CONVERSATION }, promptTokens: first }),
    "worker",
  );
  h.onModel(() => ({ text: "done", promptTokens: second }), "worker");
  configureMain(scratch, cardd.url, mainToken, {
    workerArgs: [...wireArgs(), "--model", `tier/${model}`, "-e", PROBE],
    ...lane,
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

test("a worker on a routed 1M model compacts at 200K of its 250K limit", async () => {
  const compaction = await runWorker("routed", BELOW_COMPACTION, ABOVE_COMPACTION);

  assert.equal(workerCallsBefore(compaction), 2);
});

test("a lane's costs.workerContextCap sets its workers' limit: 500K compacts at 400K", async () => {
  const compaction = await runWorker("routed", BELOW_WIDER_COMPACTION, ABOVE_WIDER_COMPACTION, {
    costs: { workerContextCap: 500_000 },
  });

  assert.equal(workerCallsBefore(compaction), 2);
});

test("a worker on a 200K model compacts at 160K, before its own limit, and is never told it has 250K", async () => {
  const compaction = await runWorker("small", BELOW_SMALL_COMPACTION, ABOVE_SMALL_COMPACTION);

  assert.equal(workerCallsBefore(compaction), 2);
});

test("a worker whose tier routes from a 1M model to a 200K model compacts on the second model's 160K", async () => {
  const compaction = await runWorker("swing", ABOVE_SMALL_COMPACTION, ABOVE_SMALL_COMPACTION);

  assert.equal(workerCallsBefore(compaction), 1);
});

test("a mate over the worker limit keeps its whole context, as Pi's own settings say", async () => {
  h.onModel(
    () => ({
      tool: "slow_tool",
      args: { notes: LONG_CONVERSATION },
      promptTokens: MATE_OVER_WORKER_LIMIT,
    }),
    "mate",
  );
  h.onModel(() => ({ text: "first", promptTokens: MATE_OVER_WORKER_LIMIT }), "mate");
  configureMain(scratch, cardd.url, mainToken);
  await startMain(lab, scratch, h, false, [...wireArgs(), "-e", PROBE]);
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to join the fleet");
  h.send(1, "followUp", "Are you there?");
  await h.waitFor((event) => event["type"] === "tool_waiting", "the mate to wait in its tool");
  h.releaseTool();
  await h.waitForCall(1, "mate", WAIT_MS);
  h.send(2, "followUp", "And now?");
  await h.waitForCall(2, "mate", WAIT_MS);

  assert.equal(h.wire.filter(askedByMate).length, 3);
  assert.equal(h.wire.filter(isCompaction).length, 0);
});

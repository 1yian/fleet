// A worker never runs on its mate's tier. The fleet repo's .pi/settings.json puts main on the
// orchestrator tier, and every worktree of the repo has that file, so a worker dispatched into one
// used to start on the orchestrator tier too. Main here is a plain Pi in a scratch copy of the
// repo that picks its model from its settings, as the captain's does. The scripted model answers
// as the captain's tiers and tells the test which model each call went to.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch, settingsArgs, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

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
  // The fleet repo is a project like any other: its workers run in worktrees of it.
  cardd.addProject("fleet", { local: scratch.root });
  // Pi's global default, as in the captain's own settings.
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  writeFileSync(
    join(h.dir, "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "tier", defaultModel: "auto" }),
  );
  // A key for the scripted tiers, as the captain has keys for the real ones. Pi picks a model from
  // its settings only when it knows a key for the model's provider when the session starts.
  writeFileSync(
    join(h.dir, "agent", "models.json"),
    JSON.stringify({ providers: { tier: { apiKey: "scripted" } } }),
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

const systemOf = (turns: Turn[]): string =>
  turns.find((turn) => turn.role === "system")?.text ?? "";
const isWorker = (turns: Turn[]): boolean => systemOf(turns).includes("# Worker role contract");

/**
 * Main, woken by a question from cleo, makes a card in the fleet project and dispatches it. Main and
 * its worker share the lab's model agent, so the system prompt tells their calls apart. Returns the
 * model of main's first call and of the worker's first call.
 */
async function dispatchWorker(): Promise<{ main: string; worker: string }> {
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
  await startMain(lab, scratch, h, false, settingsArgs(h));
  const asked: unknown = await cleo.call("card.new", { title: "Ship the fix", kind: "scout" });
  await cleo.call("hold", {
    card: Number(Reflect.get(Object(asked), "id")),
    question: "Ship the fix?",
    options: ["Yes"],
  });
  // Main's first two calls make the card and dispatch it. The worker's first call comes after them.
  for (let index = 2; ; index += 1) {
    const turns = await h.waitForCall(index, "mate", WAIT_MS);
    if (isWorker(turns))
      return { main: h.modelsOf("mate")[0] ?? "", worker: h.modelsOf("mate")[index] ?? "" };
  }
}

/** Pi arguments for main's workers in lane.json, besides any model: the scripted model's extension and isolation. */
const workerBase = (): string[] => settingsArgs(h);

test("a worker in a worktree of the fleet repo starts on Pi's global default, while main stays on the orchestrator tier", async () => {
  configureMain(scratch, cardd.url, mainToken, { workerArgs: workerBase() });
  const models = await dispatchWorker();
  assert.equal(models.main, "tier/orchestrator");
  assert.equal(models.worker, "tier/auto");
});

test("a model in the lane's workerArgs is the model its workers start on", async () => {
  configureMain(scratch, cardd.url, mainToken, {
    workerArgs: [...workerBase(), "--model", "tier/quick"],
  });
  const models = await dispatchWorker();
  assert.equal(models.main, "tier/orchestrator");
  assert.equal(models.worker, "tier/quick");
});

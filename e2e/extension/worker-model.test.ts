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
  cardd.addProject("fleet", { local: scratch.root });
  mkdirSync(join(h.dir, "agent"), { recursive: true });
  writeFileSync(
    join(h.dir, "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "tier", defaultModel: "auto" }),
  );
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
  for (let index = 2; ; index += 1) {
    const turns = await h.waitForCall(index, "mate", WAIT_MS);
    if (isWorker(turns))
      return { main: h.modelsOf("mate")[0] ?? "", worker: h.modelsOf("mate")[index] ?? "" };
  }
}

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

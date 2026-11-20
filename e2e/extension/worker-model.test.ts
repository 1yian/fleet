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

const DEFAULT_TASK = "fix the scrollbar";
const GPT_TASK = "Review the Spanish product copy";

async function startMate(attempts: readonly (string | undefined)[], task: string): Promise<string> {
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  for (const each of attempts)
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
          task,
          ...(each === undefined ? {} : { model: each }),
        },
      };
    }, "mate");
  const pane = await startMain(lab, scratch, h, false, settingsArgs(h));
  const asked: unknown = await cleo.call("card.new", { title: "Ship the fix", kind: "scout" });
  await cleo.call("hold", {
    card: Number(Reflect.get(Object(asked), "id")),
    question: "Ship the fix?",
    options: ["Yes"],
  });
  return pane;
}

async function dispatchWorker(
  model?: string | readonly string[],
  task = model === undefined ? DEFAULT_TASK : GPT_TASK,
): Promise<{ main: string; worker: string; pane: string }> {
  const attempts = model === undefined ? [undefined] : [model].flat();
  const pane = await startMate(attempts, task);
  for (let index = 1 + attempts.length; ; index += 1) {
    const turns = await h.waitForCall(index, "mate", WAIT_MS);
    if (isWorker(turns))
      return { main: h.modelsOf("mate")[0] ?? "", worker: h.modelsOf("mate")[index] ?? "", pane };
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

test("an explicit GPT worker keeps its model after an ordinary restart", async () => {
  configureMain(scratch, cardd.url, mainToken, {
    workerArgs: [...workerBase(), "--model", "tier/quick"],
  });
  const first = await dispatchWorker("openai-codex/gpt-fixture");
  const card = (await cardd.board()).cards.find((each) => each.name === "one-scrollbar");
  assert.ok(card);
  let requested = false;
  for (let call = 0; call < 12; call += 1)
    h.onModel((turns) => {
      if (isWorker(turns))
        return turns.at(-1)?.role === "toolResult"
          ? { text: "continuing" }
          : { tool: "report", args: { status: "working", text: "reviewing copy" } };
      if (requested) return { text: "restarted" };
      requested = true;
      return { tool: "restart_card", args: { card: card.id, key: "gpt-restart" } };
    }, "mate");
  const before = h.callsOf("mate").length;
  await lab.run(["pane", "send-text", first.pane, "restart the copy worker"]);
  await lab.run(["pane", "send-keys", first.pane, "enter"]);
  for (let index = before; ; index += 1) {
    const turns = await h.waitForCall(index, "mate", WAIT_MS);
    if (!isWorker(turns) || !turns.some((turn) => turn.text.includes("session was restarted")))
      continue;
    assert.equal(h.modelsOf("mate")[index], "openai-codex/gpt-fixture");
    assert.ok(requested);
    break;
  }
});

for (const flags of [
  ["--provider", "tier", "--model", "quick"],
  ["--provider=tier", "--model=tier/quick"],
]) {
  test(`an explicit GPT dispatch overrides lane model flags ${flags.join(" ")}`, async () => {
    configureMain(scratch, cardd.url, mainToken, {
      workerArgs: [...workerBase(), ...flags],
    });
    const models = await dispatchWorker("openai-codex/gpt-fixture");
    assert.equal(models.main, "tier/orchestrator");
    assert.equal(models.worker, "openai-codex/gpt-fixture");
  });
}

const VIDEO_TASK =
  "Revise the launch video: re-cut the intro and fix the flicker in the title card";

function installTiers(): void {
  const chain = ["openai-codex/gpt-fixture:medium"];
  writeFileSync(
    join(h.dir, "agent", "tiers.json"),
    JSON.stringify({
      tiers: {
        default: { description: "Build or fix from a known plan, spec, or reproduction.", chain },
        deep: { description: "Open-ended investigation and hard design problems.", chain },
        visual: {
          description: "Work judged mainly on how it looks: video, images, and UI visuals.",
          chain,
        },
      },
    }),
  );
}

const offeredTiers = (system: string): string[] =>
  [...system.matchAll(/^- (tier\/\S+?):?(?: |$)/gm)].map((found) => found[1] ?? "");

test("on an install with no router, the mate sees the tiers its tiers.json defines and a visual job it dispatches on tier/visual starts there", async () => {
  installTiers();
  configureMain(scratch, cardd.url, mainToken, { workerArgs: workerBase() });
  const models = await dispatchWorker("tier/visual", VIDEO_TASK);
  assert.equal(models.main, "tier/orchestrator");
  assert.equal(models.worker, "tier/visual");
  const seen = systemOf(h.callsOf("mate")[0] ?? []);
  assert.match(seen, /## Worker tiers\nNo tier router works on this install/);
  assert.deepEqual(offeredTiers(seen), ["tier/default", "tier/deep", "tier/visual"]);
});

test("a dispatch that names a tier the install does not define is refused with the defined tiers, before any card or worker exists", async () => {
  installTiers();
  configureMain(scratch, cardd.url, mainToken, { workerArgs: workerBase() });
  await startMate(["tier/cinematic"], VIDEO_TASK);
  const turns = await h.waitForCall(2, "mate", WAIT_MS);
  const refusal = turns.findLast((turn) => turn.role === "toolResult")?.text ?? "";
  assert.match(refusal, /tier\/cinematic is not a tier this install defines/);
  assert.match(refusal, /one of: tier\/default, tier\/deep, tier\/visual/);
  assert.equal(
    (await cardd.board()).cards.some((each) => each.name === "one-scrollbar"),
    false,
  );
  assert.equal(h.callsOf("mate").some(isWorker), false);
});

test("a mate that is refused an undefined tier dispatches again on a defined one", async () => {
  installTiers();
  configureMain(scratch, cardd.url, mainToken, { workerArgs: workerBase() });
  const models = await dispatchWorker(["tier/cinematic", "tier/visual"], VIDEO_TASK);
  assert.equal(models.worker, "tier/visual");
});

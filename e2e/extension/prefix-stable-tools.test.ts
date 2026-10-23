import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
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
const LATE_TOOLS = fileURLToPath(new URL("late-tools.ts", SUPPORT));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab | undefined;
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
});
afterEach(async (t) => {
  await lab?.printIfFailed(t);
  const stopped = await Promise.allSettled([cleo.close(), lab?.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

function wireArgs(): string[] {
  const args = settingsArgs(h);
  const at = args.indexOf(FAKE_MODEL);
  return [...args.slice(0, at - 1), ...args.slice(at + 1), "-e", FAKE_ANTHROPIC];
}

const toolsSection = (system: string): string =>
  system.slice(system.indexOf("<tools>"), system.indexOf("</tools>"));

test("a worker's first request already carries the tools a slow extension adds at startup", async () => {
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
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
  h.onModel(() => ({ tool: "slow_tool" }), "worker");
  configureMain(scratch, cardd.url, mainToken, {
    workerArgs: [...wireArgs(), "-e", PROBE, "-e", LATE_TOOLS],
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
  await h.waitForCall(1, "worker", WAIT_MS);

  const calls = h.wire.filter((call) => call.role === "worker" && !call.warm);
  assert.ok(calls.length >= 2);
  const first = calls[0];
  assert.ok(first?.tools.includes("late_search"), "the first request declares the late tool");
  const firstSection = toolsSection(first?.turns[0]?.text ?? "");
  assert.match(firstSection, /late_search: Late search/);
  for (const call of calls) {
    assert.deepEqual(call.tools, first?.tools, "the declared tools never change");
    assert.equal(
      toolsSection(call.turns[0]?.text ?? ""),
      firstSection,
      "the prompt tools never change",
    );
  }
});

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
const LIMIT = fileURLToPath(new URL("codemode-limit.ts", SUPPORT));

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

const sawLimit = (role: "mate" | "worker"): string =>
  h.wire
    .filter((call) => call.role === role && !call.warm)
    .flatMap((call) => call.turns.map((turn) => turn.text))
    .join("\n");

test("every started mate and worker has codemode and the raised codemode limit", async () => {
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
  h.onModel(() => ({ tool: "codemode_limit", args: {} }), "mate");
  h.onModel(
    () => ({
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
    }),
    "mate",
  );
  h.onModel(() => ({ tool: "codemode_limit", args: {} }), "worker");
  configureMain(scratch, cardd.url, mainToken, { workerArgs: [...wireArgs(), "-e", LIMIT] });
  await startMain(lab, scratch, h, false, [...wireArgs(), "-e", LIMIT]);
  const asked: unknown = await cleo.call("card.new", { title: "Ship the fix", kind: "scout" });
  await cleo.call("hold", {
    card: Number(Reflect.get(Object(asked), "id")),
    question: "Ship the fix?",
    options: ["Yes"],
  });
  await h.waitForCall(1, "mate", WAIT_MS);
  await h.waitForCall(1, "worker", WAIT_MS);

  for (const role of ["mate", "worker"] as const) {
    const first = h.wire.find((call) => call.role === role && !call.warm);
    assert.ok(first?.tools.includes("codemode"), `the ${role} declares codemode`);
    assert.ok(first?.tools.includes("codemode_limit"), `the ${role} keeps its other tools`);
    assert.match(sawLimit(role), /limit=4/, `the ${role} runs with the raised limit`);
  }
});

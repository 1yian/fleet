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

async function startLab(inherited: string): Promise<HerdrLab> {
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PI_CACHE_RETENTION: inherited,
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
  });
  return lab;
}

function wireArgs(): string[] {
  const args = settingsArgs(h);
  const at = args.indexOf(FAKE_MODEL);
  return [...args.slice(0, at - 1), ...args.slice(at + 1), "-e", FAKE_ANTHROPIC];
}

const requests = (role: "mate" | "worker") =>
  h.wire.filter((call) => call.role === role && !call.warm);

test("main asks for five-minute prompt retention, whatever it inherits", async () => {
  const herdr = await startLab("long");
  h.onModel(() => ({ tool: "slow_tool" }), "mate");
  configureMain(scratch, cardd.url, mainToken);
  await startMain(herdr, scratch, h, false, wireArgs());
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to join the fleet");
  h.send(1, "followUp", "Are you there?");
  const waiting = await h.waitFor(
    (event) => event["type"] === "tool_waiting",
    "the mate to wait in its tool",
  );
  h.releaseTool();
  await h.waitForCall(1, "mate", WAIT_MS);

  assert.equal(waiting["background"], "", "a mate is not background work");
  assert.ok(requests("mate").length >= 2);
  for (const call of requests("mate"))
    assert.deepEqual([...new Set(call.ttls)], ["default"], "no breakpoint asks for one hour");
});

test("a worker keeps the five-minute retention, whatever main inherited, and runs as pi-tiers background work", async () => {
  const herdr = await startLab("long");
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
  h.onModel(() => ({ tool: "slow_tool" }), "worker");
  configureMain(scratch, cardd.url, mainToken, { workerArgs: [...wireArgs(), "-e", PROBE] });
  await startMain(herdr, scratch, h, false, wireArgs());
  const asked: unknown = await cleo.call("card.new", { title: "Ship the fix", kind: "scout" });
  await cleo.call("hold", {
    card: Number(Reflect.get(Object(asked), "id")),
    question: "Ship the fix?",
    options: ["Yes"],
  });

  const waiting = await h.waitFor(
    (event) => event["type"] === "tool_waiting",
    "the worker to wait in its tool",
  );
  h.releaseTool();
  await h.waitForCall(1, "worker", WAIT_MS);

  assert.equal(waiting["background"], "1");
  assert.ok(requests("worker").length >= 2);
  for (const call of requests("worker"))
    assert.deepEqual([...new Set(call.ttls)], ["default"], "no breakpoint asks for one hour");
});

test("a second mate whose lane sets costs.mateCacheRetention to long asks for one-hour retention, and again after a restart", async () => {
  const herdr = await startLab("short");
  scratch.addLane("cnp", {
    url: cardd.url,
    token: cardd.addLane("cnp", "main"),
    args: [...wireArgs(), "-e", PROBE],
    costs: { mateCacheRetention: "long" },
  });
  const fleet = (...args: string[]): string =>
    scratch.fleet(args, {
      ...h.piEnv("mate"),
      PI_CACHE_RETENTION: "short",
      HERDR_SESSION: herdr.name,
    });

  const main = await cardd.connect(mainToken);
  assert.match(fleet("up", "cnp"), /cnp: started/);
  await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to join the fleet");
  await main.call("comment", { lane: "cnp", text: "Are you there?" });
  await h.waitForCall(0, "mate", WAIT_MS);
  assert.match(fleet("restart", "cnp"), /cnp: started/);
  await h.waitForNth(
    (event) => event["type"] === "fleet_connected",
    2,
    "the mate to join again after the restart",
  );
  await main.call("comment", { lane: "cnp", text: "Still there?" });
  await h.waitForCall(1, "mate", WAIT_MS);

  await main.close();
  assert.ok(requests("mate").length >= 2);
  for (const call of requests("mate"))
    assert.deepEqual([...new Set(call.ttls)], ["1h"], "every cache breakpoint asks for one hour");
});

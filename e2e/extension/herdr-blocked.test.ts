import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { isRecord } from "../support/json.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
let ghostToken: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  mkdirSync(join(h.dir, "agent", "extensions"), { recursive: true });
  execFileSync("herdr", ["integration", "install", "pi"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: join(h.dir, "agent") },
  });
  here = new Scratch();
  configureMain(here, cardd.url, cardd.addLane("main", undefined, here.root));
  ghostToken = cardd.addLane("ghost", "main");
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function agentOf(pane: string): Promise<{ status: string }> {
  const got = await lab.run(["pane", "get", pane]);
  const info = isRecord(got["pane"]) ? got["pane"] : {};
  return { status: String(info["agent_status"]) };
}

async function until(
  pane: string,
  what: string,
  done: (state: { status: string }) => boolean,
): Promise<{ status: string }> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const state = await agentOf(pane);
    if (done(state)) return state;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}: ${JSON.stringify(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function wake(name: string): Promise<void> {
  const ghost = await cardd.connect(ghostToken);
  const card = check(CardSchema, await ghost.call("card.new", { title: name, kind: "scout" }));
  await ghost.call("hold", { card: card.id, question: "ok?", options: ["Yes"] });
  await ghost.close();
}

test("a mate whose turn failed reads blocked in herdr with the cause, and the next good turn clears it", async () => {
  h.onModel(() => ({ fail: "You exceeded your current quota, please check your plan" }), "mate");
  h.onModel(() => ({ text: "all well" }), "mate");
  const pane = await startMain(lab, here, h);
  await until(pane, "the mate to settle idle", (s) => s.status === "idle");

  await wake("first");
  await until(pane, "blocked", (s) => s.status === "blocked");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal((await agentOf(pane)).status, "blocked");

  await wake("second");
  await until(pane, "idle after a good turn", (s) => s.status === "idle");
});

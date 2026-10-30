import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { isRecord, records, type JsonRecord } from "../support/json.ts";
import { mateArgs, Scratch } from "../support/scratch.ts";

const WAIT_MS = 60_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let here: Scratch;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  here = new Scratch();
  cardd.addLane("main", undefined, here.root);
  here.addLane("ops", {
    url: cardd.url,
    token: cardd.addLane("ops", "main"),
    args: mateArgs(h),
  });
  lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
  });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  here.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const fleet = (args: readonly string[]): JsonRecord[] => {
  const out = here.fleet([...args, "--json"], { ...lab.env, HERDR_SESSION: lab.name });
  const parsed: unknown = JSON.parse(out);
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
};

async function until<T>(read: () => T | undefined | Promise<T | undefined>, what: string) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const state = (): unknown => fleet(["status"]).find((row) => row["lane"] === "ops")?.["state"];

test("fleet starts a herdr server that is not running, and starts the lanes again on it", async () => {
  assert.equal(fleet(["up"])[0]?.["action"], "started");
  await until(() => (state() === "running" ? true : undefined), "ops to run");

  await lab.killServer();
  const out = fleet(["up", "--maintenance"]);
  assert.equal(out.find((row) => row["lane"] === "ops")?.["action"], "started");
  await until(() => (state() === "running" ? true : undefined), "ops to run again");
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  assert.equal(workspaces.filter((each) => each["label"] === "2ndmate-ops").length, 1);
});

test("a recorded pane that herdr no longer has counts as a mate that is down", async () => {
  fleet(["up"]);
  await until(() => (state() === "running" ? true : undefined), "ops to run");
  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const workspace = String(
    workspaces.find((each) => each["label"] === "2ndmate-ops")?.["workspace_id"],
  );
  const panes = records((await lab.run(["pane", "list", "--workspace", workspace]))["panes"]);
  const pane = String(panes[0]?.["pane_id"]);
  await lab.run(["pane", "close", pane]);
  assert.equal(state(), "down");
});

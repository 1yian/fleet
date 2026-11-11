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
  here.addLane("loopy", {
    url: cardd.url,
    token: `-${cardd.addLane("loopy", "main")}`,
    args: ["--approve", "--definitely-not-an-option"],
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

async function until<T>(read: () => T | undefined | Promise<T | undefined>, what: string) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function rowsOf(args: readonly string[]): JsonRecord[] {
  const parsed: unknown = JSON.parse(here.fleet([...args, "--json"], { HERDR_SESSION: lab.name }));
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
}
const rowOf = (args: readonly string[]): JsonRecord | undefined =>
  rowsOf(args).find((row) => row["lane"] === "loopy");
const stateOf = (): unknown => rowOf(["status"])?.["state"];

async function heldThenStartedByHand(): Promise<string> {
  for (let start = 1; start <= 3; start += 1) {
    assert.equal(rowOf(["up"])?.["action"], "started");
    await until(() => (stateOf() === "down" ? true : undefined), "loopy to die");
  }
  assert.equal(rowOf(["up"])?.["action"], "held");
  assert.equal(stateOf(), "stopped");
  here.fleet(["home", "set", "loopy", "--args", JSON.stringify(mateArgs(h))]);

  const workspaces = records((await lab.run(["workspace", "list"]))["workspaces"]);
  const workspace = workspaces.find((each) => each["label"] === "2ndmate-loopy");
  const listed = await lab.run([
    "pane",
    "list",
    "--workspace",
    String(workspace?.["workspace_id"]),
  ]);
  const pane = String(records(listed["panes"])[0]?.["pane_id"]);
  const args = ["--continue", ...mateArgs(h)].map((arg) => `'${arg}'`).join(" ");
  await lab.submit(pane, `pi ${args}`);
  await until(() => (stateOf() === "running" ? true : undefined), "loopy to run by hand");
  return pane;
}

test("a lane that runs is never reported as held for an old crash loop, and a later crash is not held by it", async () => {
  const pane = await heldThenStartedByHand();

  assert.equal(rowOf(["up"])?.["action"], "running");
  assert.equal(stateOf(), "running");
  assert.equal(rowOf(["status"])?.["reason"], undefined);

  const info = records([(await lab.run(["pane", "process-info", "--pane", pane]))["process_info"]]);
  process.kill(-Number(info[0]?.["foreground_process_group_id"]), "SIGKILL");
  await until(() => (stateOf() === "down" ? true : undefined), "loopy to die");
  assert.equal(rowOf(["up"])?.["action"], "started");
});

test("restarting every lane restarts a running lane that still has an old crash-loop stop", async () => {
  await heldThenStartedByHand();

  assert.equal(rowOf(["restart"])?.["action"], "started");
  await until(() => (stateOf() === "running" ? true : undefined), "loopy to run again");
});

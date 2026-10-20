// run_long (spec section 11.1 and cutover test 11). A real worker Pi runs a job
// in a herdr lab tab. The job's result arrives as a fleet entry, also after a
// Pi restart, and the job never runs twice.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Pi, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let env: Record<string, string>;
beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
  lab = await HerdrLab.start({});
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const [workspace] = records([created["workspace"]]).map((each) => each["workspace_id"]);
  if (typeof workspace !== "string") throw new Error("the lab returned no workspace");
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const token = await begin(fleet.main, card, "run the tests");
  env = { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" };
  env = { ...env, HERDR_SESSION: lab.name, HERDR_WORKSPACE_ID: workspace };
});
afterEach(async () => {
  // Stop everything even if one part fails, so no process outlives the test.
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), fleet.cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const worker = (): Pi => h.startPi("c-1-a1", env, [EXTENSION]);
const lastUser = (turns: Turn[]): string | undefined =>
  turns.findLast((turn) => turn.role === "user")?.text;
const said = (text: string): boolean =>
  h.calls.some((turns) => turns.some((turn) => turn.text.includes(text)));
const settled = (n: number) =>
  h.waitForNth((e) => e["type"] === "settled", n, `settle ${String(n)}`);

test("a run_long result wakes the worker, and the wait is not a stall", async () => {
  h.onModel(() => ({
    tool: "run_long",
    args: { label: "tests", command: "echo one; echo two; exit 3" },
  }));
  h.onModel(() => ({ text: "waiting for the tests" }));
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "two tests fail" } }));
  worker();
  await fleet.main.waitForEntries(1);

  assert.equal(lastUser(await h.waitForCall(2)), "[fleet] c-1 job 1 (tests) exited 3: one\ntwo");
  assert.ok(said("Started job 1 (tests) in tab job-1-tests."));
  assert.equal(said("Your run is ending without a handoff"), false);
  assert.deepEqual(
    fleet.main.entries.map(({ entry }) => [entry.fields["status"], entry.body]),
    [["failed", "two tests fail"]],
  );
  const tabs = records(
    (await lab.run(["tab", "list", "--workspace", env["HERDR_WORKSPACE_ID"] ?? ""]))["tabs"],
  );
  assert.ok(tabs.some((tab) => tab["label"] === "job-1-tests"));
});

test("a job keeps running across a worker restart, and its result arrives once", async () => {
  const counter = join(h.dir, "runs");
  const go = join(h.dir, "go");
  const command = `echo run >> ${counter}; while [ ! -f ${go} ]; do sleep 0.1; done; echo finished`;
  h.onModel(() => ({ tool: "run_long", args: { label: "wait", command } }));
  h.onModel(() => ({ text: "waiting for the job" }));
  const first = worker();
  await settled(1);
  await first.kill();
  writeFileSync(go, "");

  worker();
  await h.waitForNth((e) => e["type"] === "fleet_delivered", 2, "the job result after the restart");
  const after = await h.waitForCall(2);
  assert.equal(lastUser(after), "[fleet] c-1 job 1 (wait) exited 0: finished");
  assert.equal(after.filter((turn) => turn.text.startsWith("[fleet] c-1 job 1")).length, 1);
  assert.equal(existsSync(counter) ? readFileSync(counter, "utf8") : "", "run\n");
});

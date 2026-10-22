import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Card } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { records } from "../support/json.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const RESULT = "[fleet] c-1 users-see-one-scrollbar job 1 (tests) exited 0: green";
const AGAIN = `${RESULT} (sent again: the turn that got it ended before it was taken in)`;
const ROUTING = "no model is available for tier default: every model is cooling";

let fleet: Fleet;
let h: Harness;
let lab: HerdrLab;
let env: Record<string, string>;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.02" });
  h = await Harness.start();
  lab = await HerdrLab.start({});
  const created = await lab.run(["workspace", "create", "--no-focus"]);
  const [workspace] = records([created["workspace"]]).map((each) => each["workspace_id"]);
  if (typeof workspace !== "string") throw new Error("the lab returned no workspace");
  card = await newCard(fleet.main, "Users see one scrollbar");
  const token = await begin(fleet.main, card, "run the tests");
  const jobDir = join(h.dir, "jobs");
  mkdirSync(jobDir);
  env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: "worker",
    HERDR_SESSION: lab.name,
    HERDR_WORKSPACE_ID: workspace,
    TMPDIR: jobDir,
  };
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), fleet.cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const lastUser = (turns: Turn[]): string | undefined =>
  turns.findLast((turn) => turn.role === "user")?.text;

test("a job result the worker's next turn never takes in is sent again, then raised to its mate", async () => {
  h.onModel(() => ({ tool: "run_long", args: { label: "tests", command: "echo green" } }));
  h.onModel(() => ({ text: "waiting for the tests" }));
  for (let call = 0; call < 6; call++) h.onModel(() => ({ fail: ROUTING }));
  h.startPi("c-1-a1", env, [EXTENSION]);

  assert.equal(lastUser(await h.waitForCall(2)), RESULT);
  assert.match(lastUser(await h.waitForCall(3)) ?? "", /^\[fleet\] Your run is ending/);
  assert.equal(lastUser(await h.waitForCall(4)), AGAIN);
  const missed = await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "missed",
    "the mate to hear its worker missed the job result",
  );
  assert.equal(missed.kind, "finding");
  assert.equal(
    missed.body,
    "missed: the worker on c-1 did not take in this job-result from the job, sent twice: green",
  );
});

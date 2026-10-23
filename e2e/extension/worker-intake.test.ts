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
const ROUTING =
  "pi-tiers: no usable model for tier 'default' (anthropic/claude-opus-5-5 on anthropic: cooling, openai/gpt-5 on openai: cooling)";

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

test("a job result whose turn the provider fails is not lost: its mate hears one incident, and the result is sent again once the worker recovers", async () => {
  h.onModel(() => ({ tool: "run_long", args: { label: "tests", command: "echo green" } }));
  h.onModel(() => ({ text: "waiting for the tests" }));
  h.onModel(() => ({ fail: ROUTING }));
  h.onModel(() => ({ tool: "report", args: { status: "note", text: "alive" } }));
  h.onModel(() => ({ text: "recovered" }));
  h.onModel(() => ({ text: "took the job result" }));
  h.startPi("c-1-a1", env, [EXTENSION]);

  assert.equal(lastUser(await h.waitForCall(2)), RESULT);
  const heard = await fleet.main.waitForEntry(
    (entry) => entry.fields["condition"] === "runtime-failure",
    "the mate to hear why the worker could not take the job result",
  );
  assert.match(
    heard.body,
    new RegExp(
      `its model turn failed: ${ROUTING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Classified router-cooldown\\.`,
    ),
  );
  const due = await fleet.main.waitForEntry(
    (entry) => entry.body.includes("is eligible for recovery now"),
    "the one wake at the eligible time",
  );
  const [, incident, generation] =
    /Incident (\d+), process generation (\d+)/.exec(heard.body) ?? [];
  await fleet.main.call("card.restart", {
    card: heard.card,
    incident: Number(incident),
    generation: Number(generation),
    mode: "retry",
    key: "mate-retry",
  });
  await fleet.main.waitForEntry(
    (entry) => entry.body.includes("recovered (retry)"),
    "verification",
  );

  assert.equal(lastUser(await h.waitForCall(5)), AGAIN);
  assert.ok(due.id > heard.id);
  const entries = fleet.main.entries.map((push) => push.entry);
  assert.equal(entries.filter((entry) => entry.fields["condition"] === "missed").length, 0);
  assert.equal(
    h.calls
      .slice(0, 5)
      .flat()
      .filter((turn) => turn.text.startsWith("[fleet] Your run is ending")).length,
    0,
  );
});

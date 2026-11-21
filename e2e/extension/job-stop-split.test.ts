import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { JobLab } from "../support/job-lab.ts";
import { records } from "../support/json.ts";
import { until } from "../support/live-fleet.ts";

let jl: JobLab;
beforeEach(async () => {
  jl = await JobLab.start("1");
});
afterEach(async (t) => {
  await jl.stop(t);
});

test("a stop signals no pane of a split job tab once the pane that ran the job left it", async (t) => {
  jl.env["PROBE_STOP_RESULT"] = "1";
  const proxy = await jl.proxy(t);
  const shim = jl.installShim();
  writeFileSync(shim.release, "");
  jl.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "sleep 600" } }));
  jl.h.onModel(() => ({ text: "The gate is running" }));
  const pi = jl.worker();
  await until(() => (proxy.activities.includes("waiting") ? true : undefined), "the job's wait");
  await until(
    () => (typeof jl.wrapperPid() === "number" ? true : undefined),
    "the wrapper to register",
  );
  const workspace = jl.env["HERDR_WORKSPACE_ID"] ?? "";
  const tab = (await jl.tabs()).find((each) => each["label"] === "job-1-gate");
  assert.ok(tab);
  const listed = async () =>
    records((await jl.lab.run(["pane", "list", "--workspace", workspace]))["panes"]).filter(
      (each) => each["tab_id"] === tab["tab_id"],
    );
  const [original] = await listed();
  assert.ok(original);
  await jl.lab.run(["pane", "split", String(original["pane_id"]), "--direction", "right"]);
  assert.equal((await listed()).length, 2);
  await jl.lab.run(["pane", "move", String(original["pane_id"]), "--new-tab"]);
  const remaining = await listed();
  assert.equal(remaining.length, 1);
  assert.notEqual(remaining[0]?.["pane_id"], original["pane_id"]);

  jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  jl.h.onModel(() => ({ text: "The stop was refused" }));
  pi.prompt("Stop the gate job");
  const stopped = await jl.h.waitFor(
    (event) => event["type"] === "stop_result",
    "the stop after the original pane left its tab",
  );
  assert.equal(stopped["isError"], false);
  assert.deepEqual(stopped["content"], [
    {
      type: "text",
      text: "job 1 (gate) has no pane left in its tab in your workspace, so nothing was signalled. If it is still recorded as running, it is reported lost soon.",
    },
  ]);
  assert.equal(existsSync(shim.keys), false);
});

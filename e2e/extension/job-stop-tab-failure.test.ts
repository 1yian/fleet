import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { JobLab } from "../support/job-lab.ts";

let jl: JobLab;
beforeEach(async () => {
  jl = await JobLab.start("1");
});
afterEach(async (t) => {
  await jl.stop(t);
});

test("a stop after the launch's tab creation failed signals no same-named decoy", async (t) => {
  jl.env["PROBE_STOP_RESULT"] = "1";
  const proxy = await jl.proxy(t);
  proxy.httpFault(
    "job.prepare",
    { status: 400, body: { ok: false, error: "unknown operation job.prepare" } },
    1,
  );
  const shim = jl.installShim();
  writeFileSync(shim.failTab, "");
  await jl.lab.run([
    "tab",
    "create",
    "--workspace",
    jl.env["HERDR_WORKSPACE_ID"] ?? "",
    "--label",
    "job-1-gate",
    "--no-focus",
  ]);
  jl.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "echo gate" } }));
  jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  jl.h.onModel(() => ({ text: "The stop was refused" }));
  jl.worker();
  const stopped = await jl.h.waitFor(
    (event) => event["type"] === "stop_result",
    "the stop after the failed launch",
  );
  assert.equal(stopped["isError"], false);
  assert.deepEqual(stopped["content"], [
    {
      type: "text",
      text: "job 1 (gate) is still starting in this worker, so nothing was signalled.",
    },
  ]);
  assert.ok(proxy.replied.includes("job.start"));
  assert.equal(existsSync(shim.keys), false);
});

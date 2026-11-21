import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { JobLab } from "../support/job-lab.ts";
import { until } from "../support/live-fleet.ts";

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

const STILL_STARTING = [
  {
    type: "text",
    text: "job 1 (gate) is still starting in this worker, so nothing was signalled.",
  },
];

async function legacyProxy(t: Parameters<typeof JobLab.prototype.proxy>[0]) {
  jl.env["PROBE_STOP_RESULT"] = "1";
  const proxy = await jl.proxy(t);
  proxy.httpFault(
    "job.prepare",
    { status: 400, body: { ok: false, error: "unknown operation job.prepare" } },
    1,
  );
  return proxy;
}

test("a stop after the legacy start receipt was lost signals no same-named decoy", async (t) => {
  const proxy = await legacyProxy(t);
  proxy.callFault("job.start", { lose: true });
  const shim = jl.installShim();
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
  jl.h.onModel(() => ({ text: "The start receipt was lost" }));
  const pi = jl.worker();
  await jl.h.waitForNth(
    (event) => event["type"] === "fleet_connected",
    2,
    "the worker to reconnect after the lost receipt",
  );
  assert.ok(proxy.replied.includes("job.start"));
  jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  jl.h.onModel(() => ({ text: "The stop was refused" }));
  pi.prompt("Stop the gate job");
  const stopped = await jl.h.waitFor(
    (event) => event["type"] === "stop_result",
    "the stop after the lost receipt",
  );
  assert.equal(stopped["isError"], false);
  assert.deepEqual(stopped["content"], STILL_STARTING);
  assert.equal(existsSync(shim.keys), false);
});

test("a stop while the launch's tab exists but its command is not dispatched signals nothing", async (t) => {
  const proxy = await legacyProxy(t);
  const shim = jl.installShim();
  writeFileSync(shim.release, "");
  const contained = jl.holdHerdr(shim.holdContain);
  proxy.callFault("job.stop", { gate: contained.held });
  jl.h.onModel(() => ({
    tool: "run_long",
    args: { label: "gate", command: "echo gate" },
    alongside: [{ tool: "stop_job", args: { job: 1 } }],
  }));
  jl.h.onModel(() => ({ text: "The stop came before dispatch" }));
  jl.worker();
  const stopped = await jl.h.waitFor(
    (event) => event["type"] === "stop_result",
    "the stop that came before dispatch",
  );
  assert.equal(stopped["isError"], false);
  assert.deepEqual(stopped["content"], STILL_STARTING);
  assert.equal(existsSync(shim.keys), false);
  assert.ok(await jl.tabs().then((tabs) => tabs.some((tab) => tab["label"] === "job-1-gate")));
  await contained.release();
  await until(
    async () => ((await jl.jobResults()).length === 1 ? true : undefined),
    "the released launch to dispatch and finish",
  );
  assert.deepEqual(await jl.jobResults(), [[1, 0, "gate"]]);
  assert.equal(existsSync(shim.keys), false);
});

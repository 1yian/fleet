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

const STILL_STARTING = [
  {
    type: "text",
    text: "job 1 (gate) is still starting in this worker, so nothing was signalled.",
  },
];

const NO_TAB = [
  {
    type: "text",
    text: "job 1 (gate) has no verified tab ID in this worker session, so nothing was signalled. After a worker replacement its tab cannot be proven, and a tab name is never used as proof.",
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

type Proxy = Awaited<ReturnType<typeof legacyProxy>>;
type Shim = ReturnType<typeof jl.installShim>;

const scenarios: {
  name: string;
  connections: number;
  setup: (proxy: Proxy, shim: Shim) => void;
}[] = [
  {
    name: "the launch's tab creation failed",
    connections: 1,
    setup: (_proxy, shim) => writeFileSync(shim.failTab, ""),
  },
  {
    name: "the legacy start receipt was lost",
    connections: 2,
    setup: (proxy) => proxy.callFault("job.start", { lose: true }),
  },
  {
    name: "the tab receipt carried a blank tab ID",
    connections: 1,
    setup: (_proxy, shim) => writeFileSync(shim.blankTabId, ""),
  },
  {
    name: "the tab receipt carried no tab ID",
    connections: 1,
    setup: (_proxy, shim) => writeFileSync(shim.noTabId, ""),
  },
];

for (const scenario of scenarios)
  for (const replaced of [false, true])
    test(`a stop ${replaced ? "from a replacement worker" : "in the same worker"} after ${scenario.name} signals no same-named decoy`, async (t) => {
      const proxy = await legacyProxy(t);
      const shim = jl.installShim();
      scenario.setup(proxy, shim);
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
      jl.h.onModel(() => ({ text: "The launch did not complete" }));
      let pi = jl.worker();
      await jl.h.waitForNth(
        (event) => event["type"] === "fleet_connected",
        scenario.connections,
        "the worker to connect after the launch",
      );
      await jl.h.waitForNth((event) => event["type"] === "settled", 1, "the launch to settle");
      assert.ok(proxy.replied.includes("job.start"));
      if (replaced) {
        await pi.kill();
        pi = jl.worker();
        await jl.h.waitForNth(
          (event) => event["type"] === "fleet_connected",
          scenario.connections + 1,
          "the replacement worker to connect",
        );
      }
      jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
      jl.h.onModel(() => ({ text: "The stop was refused" }));
      pi.prompt("Stop the gate job");
      const stopped = await jl.h.waitFor(
        (event) => event["type"] === "stop_result",
        "the stop after the incomplete launch",
      );
      assert.equal(stopped["isError"], false);
      assert.deepEqual(stopped["content"], NO_TAB);
      assert.equal(existsSync(shim.keys), false);
      assert.equal(existsSync(shim.runs), false);
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

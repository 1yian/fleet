import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
    setup: (_proxy, shim) => {
      writeFileSync(shim.failTab, "");
    },
  },
  {
    name: "the legacy start receipt was lost",
    connections: 2,
    setup: (proxy) => {
      proxy.callFault("job.start", { lose: true });
    },
  },
  {
    name: "the tab receipt carried a blank tab ID",
    connections: 1,
    setup: (_proxy, shim) => {
      writeFileSync(shim.blankTabId, "");
    },
  },
  {
    name: "the tab receipt carried no tab ID",
    connections: 1,
    setup: (_proxy, shim) => {
      writeFileSync(shim.noTabId, "");
    },
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

for (const gate of [
  { name: "the launch's tab exists but its command is not dispatched", hold: "holdContain" },
  { name: "the pane run has not been accepted", hold: "holdRun" },
] as const)
  test(`a stop while ${gate.name} signals nothing`, async (t) => {
    const proxy = await legacyProxy(t);
    const shim = jl.installShim();
    writeFileSync(shim.release, "");
    const held = jl.holdHerdr(shim[gate.hold]);
    proxy.callFault("job.stop", { gate: held.held });
    jl.h.onModel(() => ({
      tool: "run_long",
      args: { label: "gate", command: "echo gate" },
      alongside: [{ tool: "stop_job", args: { job: 1 } }],
    }));
    jl.h.onModel(() => ({ text: "The stop came before acceptance" }));
    jl.worker();
    const stopped = await jl.h.waitFor(
      (event) => event["type"] === "stop_result",
      "the stop that came before acceptance",
    );
    assert.equal(stopped["isError"], false);
    assert.deepEqual(stopped["content"], STILL_STARTING);
    assert.equal(existsSync(shim.keys), false);
    assert.ok(await jl.tabs().then((tabs) => tabs.some((tab) => tab["label"] === "job-1-gate")));
    await held.release();
    await until(
      async () => ((await jl.jobResults()).length === 1 ? true : undefined),
      "the released launch to dispatch and finish",
    );
    assert.deepEqual(await jl.jobResults(), [[1, 0, "gate"]]);
    assert.equal(existsSync(shim.keys), false);
  });

test("a modern launch whose pane ID is blank closes its exact tab and never dispatches", async (t) => {
  jl.env["PROBE_STOP_RESULT"] = "1";
  await jl.proxy(t);
  const shim = jl.installShim();
  writeFileSync(shim.blankPaneId, "");
  jl.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "echo gate" } }));
  jl.h.onModel(() => ({ text: "The launch failed" }));
  jl.worker();
  await until(
    async () =>
      existsSync(shim.closes) && !(await jl.tabs()).some((tab) => tab["label"] === "job-1-gate")
        ? true
        : undefined,
    "the failed launch's tab to close",
  );
  assert.equal(readFileSync(shim.creates, "utf8").trim().split("\n").length, 1);
  assert.equal(readFileSync(shim.closes, "utf8").trim().split("\n").length, 1);
  assert.equal(existsSync(shim.runs), false);
  assert.deepEqual(await jl.jobResults(), [
    [1, 127, "could not start: herdr did not return the job pane ID"],
  ]);
});

for (const modern of [true, false])
  test(`a ${modern ? "modern" : "legacy"} launch whose root pane belongs to another tab never dispatches and closes nothing`, async (t) => {
    jl.env["PROBE_STOP_RESULT"] = "1";
    if (modern) await jl.proxy(t);
    else await legacyProxy(t);
    const shim = jl.installShim();
    const panes = await jl.lab.run([
      "pane",
      "list",
      "--workspace",
      jl.env["HERDR_WORKSPACE_ID"] ?? "",
    ]);
    const unrelated = String(records(panes["panes"])[0]?.["pane_id"]);
    writeFileSync(shim.foreignPane, unrelated);
    jl.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "echo gate" } }));
    jl.h.onModel(() => ({ text: "The launch was refused" }));
    jl.worker();
    await jl.h.waitFor((event) => event["type"] === "settled", "the refused launch to settle");
    assert.equal(existsSync(shim.runs), false);
    assert.equal(existsSync(shim.keys), false);
    assert.equal(existsSync(shim.closes), false);
    assert.ok(
      records(
        (await jl.lab.run(["pane", "list", "--workspace", jl.env["HERDR_WORKSPACE_ID"] ?? ""]))[
          "panes"
        ],
      ).some((pane) => pane["pane_id"] === unrelated),
    );
    if (modern)
      assert.deepEqual(await jl.jobResults(), [
        [1, 127, "could not start: herdr returned a root pane outside the job tab"],
      ]);
  });

test("a startup failure whose finish reply never arrives still ends the launch and leaves the fence as cleanup authority", async (t) => {
  const proxy = await jl.proxy(t);
  const never = Promise.withResolvers<undefined>();
  t.after(() => {
    never.resolve(undefined);
  });
  proxy.callFault("job.finish", { hold: never.promise });
  const shim = jl.installShim();
  writeFileSync(shim.failTab, "");
  jl.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "echo gate" } }));
  jl.h.onModel(() => ({ text: "The launch ended without its finish reply" }));
  jl.worker();
  await jl.h.waitFor((event) => event["type"] === "settled", "the launch to end");
  assert.ok(proxy.replied.includes("job.finish"));
  assert.equal(existsSync(shim.runs), false);
});

test("a legacy start whose receipt never arrives ends the launch without a retry or a tab", async (t) => {
  const proxy = await legacyProxy(t);
  const never = Promise.withResolvers<undefined>();
  t.after(() => {
    never.resolve(undefined);
  });
  proxy.callFault("job.start", { hold: never.promise });
  const shim = jl.installShim();
  jl.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "echo gate" } }));
  jl.h.onModel(() => ({ text: "The start receipt never arrived" }));
  jl.worker();
  await jl.h.waitFor((event) => event["type"] === "settled", "the launch to end");
  assert.equal(proxy.calls.filter((op) => op === "job.start").length, 1);
  assert.equal(existsSync(shim.creates), false);
});

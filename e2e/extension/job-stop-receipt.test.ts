import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { quote } from "@fleet/protocol/route";
import { JobLab } from "../support/job-lab.ts";
import { until } from "../support/live-fleet.ts";

let jl: JobLab;
beforeEach(async () => {
  jl = await JobLab.start();
});
afterEach(async (t) => {
  await jl.stop(t);
});

test("a contradictory stop receipt changes nothing, and an honest receipt still stops the job", async (t) => {
  jl.env["PROBE_STOP_RESULT"] = "1";
  const done = join(jl.jobDir, "gate-done");
  const { pi, proxy, shim, tab } = await jl.holdDispatch(
    t,
    `while [ ! -e ${quote(done)} ]; do sleep 0.05; done; echo gate`,
  );
  writeFileSync(shim.release, "");
  await until(() => (jl.wrapperPid() === null ? undefined : true), "the wrapper to register");
  const mark = proxy.activities.length;
  const settles = (): number => jl.h.events.filter((event) => event["type"] === "settled").length;
  const contradictions = [
    { label: "gate", running: true, cancelled: true },
    { label: "gate", running: false, legacy: true },
    { label: "gate", running: false, cancelled: true, legacy: true },
    { label: "", running: false },
  ];
  let stops = 0;
  for (const receipt of contradictions) {
    const base = settles();
    proxy.callFault("job.stop", { value: receipt });
    jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
    jl.h.onModel(() => ({ text: "The stop receipt was refused" }));
    pi.prompt("Stop the gate job");
    stops += 1;
    const stopped = await jl.h.waitForNth(
      (event) => event["type"] === "stop_result",
      stops,
      "the contradictory stop receipt",
    );
    assert.equal(stopped["isError"], true);
    await jl.h.waitForNth(
      (event) => event["type"] === "settled",
      base + 1,
      "the worker to settle after the stop",
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(existsSync(shim.closes), false);
  assert.ok(await jl.hasTab(tab));
  assert.equal(proxy.activities.slice(mark).includes("idle"), false);
  assert.deepEqual(await jl.jobResults(), []);

  proxy.callFault("job.stop", undefined);
  jl.h.onModel(() => ({ tool: "stop_job", args: { job: 1 } }));
  jl.h.onModel(() => ({ text: "The stop was sent" }));
  pi.prompt("Stop the gate job");
  const sent = await jl.h.waitForNth(
    (event) => event["type"] === "stop_result",
    stops + 1,
    "the honest stop receipt",
  );
  assert.equal(sent["isError"], false);
  await until(
    async () => ((await jl.jobResults()).length > 0 ? true : undefined),
    "the stopped job's result",
  );
  const [result] = await jl.jobResults();
  assert.deepEqual(result?.slice(0, 2), [1, 130]);
});

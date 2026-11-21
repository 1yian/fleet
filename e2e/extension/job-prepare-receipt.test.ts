import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { JobLab } from "../support/job-lab.ts";
import { until } from "../support/live-fleet.ts";

let jl: JobLab;
beforeEach(async () => {
  jl = await JobLab.start();
});
afterEach(async (t) => {
  await jl.stop(t);
});

const prepares = (proxy: { requests: { op: string }[] }) =>
  proxy.requests.filter((request) => request.op === "job.prepare").length;

for (const [name, receipt] of [
  ["a success that also carries unavailable", { job: 1, heartbeatMs: 1000, unavailable: 42 }],
  [
    "an unavailable that also carries a heartbeat",
    { job: 1, unavailable: "expired", heartbeatMs: 1000 },
  ],
] as const)
  test(`${name} is retried as a malformed prepare receipt and launches on the honest reply`, async (t) => {
    const proxy = await jl.proxy(t);
    proxy.httpFault("job.prepare", { value: receipt }, 1);
    jl.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "echo gate" } }));
    jl.h.onModel(() => ({ text: "The launch retried" }));
    jl.worker();
    await until(
      async () => ((await jl.jobResults()).length === 1 ? true : undefined),
      "the retried launch to finish",
    );
    assert.deepEqual(await jl.jobResults(), [[1, 0, "gate"]]);
    assert.equal(prepares(proxy), 2);
  });

test("an honest unavailable receipt refuses the launch without a retry or a tab", async (t) => {
  const proxy = await jl.proxy(t);
  proxy.httpFault("job.prepare", { value: { job: 1, unavailable: "expired" } }, 1);
  const shim = jl.installShim();
  jl.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "echo gate" } }));
  jl.h.onModel(() => ({ text: "The launch was refused" }));
  jl.worker();
  await jl.h.waitFor((event) => event["type"] === "settled", "the refused launch to settle");
  assert.equal(prepares(proxy), 1);
  assert.equal(existsSync(shim.creates), false);
  assert.deepEqual(await jl.jobResults(), []);
});

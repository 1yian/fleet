import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { JobLab } from "../support/job-lab.ts";

let jl: JobLab;
beforeEach(async () => {
  jl = await JobLab.start();
});
afterEach(async (t) => {
  await jl.stop(t);
});

const said = (text: string): boolean =>
  jl.h.calls.some((turns) => turns.some((turn) => turn.text.includes(text)));

for (const [name, reply] of [
  ["a zero job number", { job: 0, heartbeatMs: 1000 }],
  ["an unsafe job number", { job: Number.MAX_SAFE_INTEGER + 2, heartbeatMs: 1000 }],
  ["a zero unavailable reservation", { job: 0, unavailable: "already finished" }],
] as const)
  test(`run_long fails closed on a prepare receipt with ${name}`, async (t) => {
    const proxy = await jl.proxy(t);
    proxy.httpFault("job.prepare", { value: reply }, 3);
    const shim = jl.installShim();
    jl.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "echo gate" } }));
    jl.h.onModel(() => ({ text: "The reservation was refused" }));
    jl.worker();
    await jl.h.waitForCall(2);
    assert.ok(said("Could not confirm the reservation for gate; no command was launched"));
    assert.equal(existsSync(shim.creates), false);
    assert.equal(existsSync(shim.runs), false);
    assert.equal(proxy.activities.includes("waiting"), false);
  });

test("a reconnect job list naming an impossible job number installs no wait", async (t) => {
  const proxy = await jl.proxy(t);
  proxy.callFault("jobs", { value: [{ id: 0, label: "ghost" }] });
  jl.h.onModel(() => ({ text: "Nothing is running" }));
  jl.worker();
  await jl.h.waitForNth((event) => event["type"] === "settled", 1, "the first turn to settle");
  assert.equal(proxy.activities.includes("waiting"), false);
});

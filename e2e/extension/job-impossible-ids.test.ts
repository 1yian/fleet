import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { quote } from "@fleet/protocol/route";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { JobLab } from "../support/job-lab.ts";
import { until } from "../support/live-fleet.ts";

const run = promisify(execFile);

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
  ["an unrepresentable heartbeat interval", { job: 1, heartbeatMs: 2_147_483_648 }],
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

test("legacy start fails closed on a receipt with a zero job number", async (t) => {
  const proxy = await jl.proxy(t);
  proxy.httpFault(
    "job.prepare",
    { status: 400, body: { ok: false, error: "unknown operation job.prepare" } },
    1,
  );
  proxy.callFault("job.start", { value: { job: 0, heartbeatMs: 1000 } });
  const shim = jl.installShim();
  jl.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "echo gate" } }));
  jl.h.onModel(() => ({ text: "The legacy start was refused" }));
  jl.worker();
  await jl.h.waitForCall(2);
  assert.equal(existsSync(shim.creates), false);
  assert.equal(existsSync(shim.runs), false);
  assert.equal(proxy.activities.includes("waiting"), false);
});

const listed = (reply: unknown) => async (t: TestContext) => {
  const proxy = await jl.proxy(t);
  proxy.callFault("jobs", { value: reply });
  const mark = Promise.withResolvers<number>();
  jl.h.onModel(async () => {
    await until(() => (proxy.lists() > 0 ? true : undefined), "the job list reply");
    mark.resolve(proxy.activities.length);
    return { text: "Nothing is running" };
  });
  jl.worker();
  const from = await mark.promise;
  await until(
    () => (proxy.activities.slice(from).some((state) => state !== "running") ? true : undefined),
    "the settled activity after the job list",
  );
  return proxy.activities.slice(from).filter((state) => state !== "running");
};

test("a reconnect job list naming an impossible job number installs no wait", async (t) => {
  const settled = await listed([{ id: 0, label: "ghost" }])(t);
  assert.equal(settled.includes("waiting"), false);
});

test("a reconnect job list naming a real job number installs a wait", async (t) => {
  const settled = await listed([{ id: 7, label: "real" }])(t);
  assert.equal(settled.includes("waiting"), true);
});

for (const [name, heartbeatMs, runs] of [
  ["an unrepresentable", 2_147_483_648, false],
  ["a representable", 1000, true],
] as const)
  test(`the wrapper ${runs ? "runs" : "refuses"} its input with ${name} heartbeat interval`, async (t) => {
    const endpoint = createServer((req, res) => {
      req.resume();
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, value: {} }));
    });
    endpoint.listen(0, "127.0.0.1");
    await once(endpoint, "listening");
    t.after(() => {
      endpoint.closeAllConnections();
      endpoint.close();
    });
    const address = endpoint.address();
    assert.ok(address && typeof address !== "string");
    const marker = join(jl.jobDir, "ran");
    const input = join(jl.jobDir, "wrapper-input.json");
    writeFileSync(
      input,
      JSON.stringify({
        url: `http://127.0.0.1:${String(address.port)}/call`,
        token: "token",
        job: 1,
        timeoutMs: 60_000,
        heartbeatMs,
        command: `touch ${quote(marker)}`,
      }),
    );
    const wrapper = fileURLToPath(new URL("../../packages/extension/src/job.ts", import.meta.url));
    const finished = await run("node", [wrapper, input]).then(
      () => 0,
      (error: { code?: number }) => error.code ?? 1,
    );
    assert.equal(existsSync(marker), runs);
    assert.equal(finished === 0, runs);
  });

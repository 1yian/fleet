import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { quote } from "@fleet/protocol/route";
import { JobLab } from "../support/job-lab.ts";
import { until } from "../support/live-fleet.ts";
import { configureMain, Scratch } from "../support/scratch.ts";

const run = promisify(execFile);
const READY = { state: "ready", blockers: [] };

let jl: JobLab;
beforeEach(async () => {
  jl = await JobLab.start();
});
afterEach(async (t) => {
  await jl.stop(t);
});

const said = (text: string): boolean =>
  jl.h.calls.some((turns) => turns.some((turn) => turn.text.includes(text)));

for (const [name, times, runs] of [
  ["every attempt", 3, false],
  ["only the first attempt", 1, true],
] as const)
  test(`a prepare reply that is both a success and a failure on ${name} ${runs ? "is retried against the honest daemon" : "fails closed before any tab or dispatch"}`, async (t) => {
    const proxy = await jl.proxy(t);
    proxy.httpFault(
      "job.prepare",
      {
        status: 200,
        body: { ok: true, value: { job: 1, heartbeatMs: 1000 }, error: "drain check failed" },
      },
      times,
    );
    const shim = jl.installShim();
    writeFileSync(shim.release, "");
    jl.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "echo gate" } }));
    jl.h.onModel(() => ({ text: "The reservation was settled" }));
    jl.worker();
    if (runs) {
      await until(
        async () => ((await jl.jobResults()).length > 0 ? true : undefined),
        "the honest retry's result",
      );
      assert.deepEqual(await jl.jobResults(), [[1, 0, "gate"]]);
    } else {
      await jl.h.waitForCall(2);
      assert.ok(said("Could not confirm the reservation for gate; no command was launched"));
      assert.equal(existsSync(shim.creates), false);
      assert.equal(existsSync(shim.runs), false);
    }
  });

for (const [name, times, runs] of [
  ["every attempt", 3, false],
  ["only the first attempt", 1, true],
] as const)
  test(`a registration reply that is both a success and a failure on ${name} ${runs ? "is retried and the command runs" : "keeps Bash from running"}`, async (t) => {
    const proxy = await jl.proxy(t);
    proxy.httpFault(
      "job.register",
      { status: 200, body: { ok: true, value: { registered: true }, retryable: true } },
      times,
    );
    const shim = jl.installShim();
    writeFileSync(shim.release, "");
    const marker = join(jl.jobDir, "ran");
    jl.h.onModel(() => ({
      tool: "run_long",
      args: { label: "gate", command: `touch ${quote(marker)}; echo gate` },
    }));
    jl.h.onModel(() => ({ text: "The gate was dispatched" }));
    jl.worker();
    await until(
      async () => ((await jl.jobResults()).length > 0 ? true : undefined),
      "the wrapper's result",
    );
    assert.equal(existsSync(marker), runs);
    assert.deepEqual(
      await jl.jobResults(),
      runs
        ? [[1, 0, "gate"]]
        : [[1, 127, "could not start: cardd did not confirm wrapper registration"]],
    );
  });

test("the cutover command never prints ready for a reply that is both a success and a failure", async (t) => {
  const scratch = new Scratch("cutover-envelope");
  t.after(() => scratch.dispose());
  const serve = async (body: unknown): Promise<string> => {
    const server: Server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `ws://127.0.0.1:${String(address.port)}/session`;
  };
  const status = () =>
    run("node", [scratch.launch, "job-cutover", "status"]).then(
      ({ stdout }) => ({ failed: false, stdout }),
      (error: unknown) => ({
        failed: true,
        stdout: error instanceof Error && "stdout" in error ? String(error.stdout) : "?",
      }),
    );
  for (const extra of [
    { error: "drain check failed" },
    { retryable: true },
    { error: "drain check failed", retryable: true },
  ]) {
    configureMain(scratch, await serve({ ok: true, value: READY, ...extra }), "token");
    assert.deepEqual(await status(), { failed: true, stdout: "" });
  }
  for (const additive of [{}, { requestId: "r-1", note: { served: "by cardd" } }]) {
    configureMain(scratch, await serve({ ok: true, value: READY, ...additive }), "token");
    const honest = await status();
    assert.equal(honest.failed, false);
    assert.deepEqual(JSON.parse(honest.stdout), READY);
  }
});

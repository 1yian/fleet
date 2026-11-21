import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { quote } from "@fleet/protocol/route";
import { JobLab } from "../support/job-lab.ts";
import { until } from "../support/live-fleet.ts";
import { configureMain, Scratch } from "../support/scratch.ts";

const run = promisify(execFile);

let jl: JobLab;
beforeEach(async () => {
  jl = await JobLab.start();
});
afterEach(async (t) => {
  await jl.stop(t);
});

async function sink(t: TestContext): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${String(address.port)}/call`, bodies };
}

test("a redirected job.prepare is never forwarded, and the honest endpoint still starts the job", async (t) => {
  const redirected = await sink(t);
  const proxy = await jl.proxy(t);
  proxy.httpFault("job.prepare", { redirect: redirected.url }, 1);
  const shim = jl.installShim();
  jl.h.onModel(() => ({ tool: "run_long", args: { label: "gate", command: "echo gate" } }));
  jl.h.onModel(() => ({ text: "The gate was dispatched" }));
  jl.worker();
  await until(
    () => (existsSync(shim.runs) ? true : undefined),
    "the honest retry to dispatch the wrapper",
  );
  assert.deepEqual(redirected.bodies, []);
  assert.deepEqual(readFileSync(shim.creates, "utf8").trim().split("\n"), ["tab"]);
});

test("a redirected job.register is never forwarded, and the honest retry still runs the command", async (t) => {
  const redirected = await sink(t);
  const proxy = await jl.proxy(t);
  proxy.httpFault("job.register", { redirect: redirected.url }, 1);
  const shim = jl.installShim();
  const marker = join(jl.jobDir, "ran");
  jl.h.onModel(() => ({
    tool: "run_long",
    args: { label: "gate", command: `touch ${quote(marker)}; echo gate` },
  }));
  jl.h.onModel(() => ({ text: "The gate was dispatched" }));
  jl.worker();
  await until(() => (existsSync(shim.runs) ? true : undefined), "the dispatch");
  writeFileSync(shim.release, "");
  await until(
    async () => ((await jl.jobResults()).length > 0 ? true : undefined),
    "the registered command's result",
  );
  assert.ok(existsSync(marker));
  assert.deepEqual(redirected.bodies, []);
  assert.deepEqual(await jl.jobResults(), [[1, 0, "gate"]]);
});

test("the cutover command never forwards its body to a redirect target, and an honest daemon still answers", async (t) => {
  const redirected = await sink(t);
  const scratch = new Scratch("cutover-redirect");
  t.after(() => scratch.dispose());
  const serve = async (respond: Parameters<typeof createServer>[1]): Promise<string> => {
    const server = createServer(respond);
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
  const redirecting = await serve((req, res) => {
    req.resume();
    res.writeHead(307, { location: redirected.url }).end();
  });
  configureMain(scratch, redirecting, "token");
  const refused = await run("node", [scratch.launch, "job-cutover", "status"]).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(refused instanceof Error);
  assert.deepEqual(redirected.bodies, []);

  const honest = await serve((req, res) => {
    req.resume();
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: true, value: { state: "ready", blockers: [] } }));
  });
  configureMain(scratch, honest, "token");
  const answered = await run("node", [scratch.launch, "job-cutover", "status"]);
  assert.deepEqual(JSON.parse(answered.stdout), { state: "ready", blockers: [] });
});

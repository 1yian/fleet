import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { check, HttpOutcomeSchema, OPS } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { spawnGuarded } from "../support/guarded.ts";
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
  t.after(() => {
    scratch.dispose();
  });
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

  const failing = await serve((req, res) => {
    req.resume();
    res
      .writeHead(503, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: true, value: { state: "ready", blockers: [] } }));
  });
  configureMain(scratch, failing, "token");
  const unavailable = await run("node", [scratch.launch, "job-cutover", "status"]).then(
    ({ stdout }) => ({ failed: false, stdout }),
    (error: unknown) => ({
      failed: true,
      stdout: error instanceof Error && "stdout" in error ? String(error.stdout) : "?",
    }),
  );
  assert.deepEqual(unavailable, { failed: true, stdout: "" });
});

test("a legacy-launched wrapper's heartbeats and result still reach cardd through a same-origin redirect", async (t) => {
  const proxy = await jl.proxy(t);
  const origin = new URL(jl.env["FLEET_URL"]?.replace(/^ws/, "http") ?? "").origin;
  proxy.httpFault("job.alive", { redirect: `${origin}/call-followed` }, 10_000);
  proxy.httpFault("job.finish", { redirect: `${origin}/call-followed` }, 10_000);
  const token = jl.env["FLEET_TOKEN"] ?? "";
  const release = join(jl.jobDir, "release-legacy");
  const command = `while [ ! -e ${quote(release)} ]; do sleep 0.05; done; echo done`;
  const reply = await jl.fleet.cardd.post(token, "job.start", { label: "gate", command });
  const outcome = check(HttpOutcomeSchema, reply.body);
  assert.ok(outcome.ok);
  const { job } = check(OPS["job.start"].result, outcome.value);
  const beatBefore = jl.jobUpdatedAt(job);
  const input = join(jl.jobDir, "legacy-input.json");
  writeFileSync(
    input,
    JSON.stringify({
      url: `${origin}/call`,
      token,
      job,
      timeoutMs: 60_000,
      heartbeatMs: 100,
      command,
    }),
  );
  const wrapper = fileURLToPath(new URL("../../packages/extension/src/job.ts", import.meta.url));
  const child = spawnGuarded(process.execPath, [wrapper, input], {
    env: { ...process.env, ...jl.lab.owned, HERDR_TAB_ID: undefined },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exited = once(child, "exit");
  await until(
    () =>
      proxy.requests.some((each) => each.op === "job.alive" && each.url === "/call-followed") &&
      jl.jobUpdatedAt(job) > beatBefore
        ? true
        : undefined,
    "the forwarded heartbeat to update cardd's live job state",
  );
  writeFileSync(release, "");
  assert.deepEqual(await exited, [0, null]);
  assert.deepEqual(await jl.jobResults(), [[job, 0, "done"]]);
  assert.ok(
    proxy.requests.some((each) => each.op === "job.finish" && each.url === "/call-followed"),
  );
});

test("fleet wake still follows a same-origin redirect", async (t) => {
  const scratch = new Scratch("wake-redirect");
  t.after(() => {
    scratch.dispose();
  });
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === "/call") res.writeHead(307, { location: "/call-followed" }).end();
    else
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, value: { entry: 7 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  configureMain(scratch, `ws://127.0.0.1:${String(address.port)}/session`, "token");
  assert.equal(scratch.fleet(["wake", "main", "check in"]).trim(), "main: woken");
});

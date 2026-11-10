import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import {
  mateConnected as connected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { guardCleanup } from "../support/guarded.ts";
import type { Harness, Pi } from "../support/harness.ts";
import { tempDir } from "../support/run-root.ts";

const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));

const SERVER = `
const { createServer } = require("node:net");
const { writeFileSync } = require("node:fs");
const [portFile] = process.argv.slice(2);
writeFileSync(portFile + ".pid", String(process.pid));
createServer().listen(0, "127.0.0.1", function () {
  writeFileSync(portFile, String(this.address().port));
});
`;

let parts: DispatchLab;
let h: Harness;
let mate: Pi;
let disarm: () => void = () => undefined;
beforeEach(async () => {
  parts = await startDispatchLab({ workerArgs: ["-e", SHELL] });
  ({ h, mate } = parts);
  parts.cardd.yolo("site");
});
afterEach(async () => {
  disarm();
  disarm = () => undefined;
  stopServer(join(h.dir, "server.port.pid"));
  await stopDispatchLab(parts);
});

function stopServer(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  try {
    process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
  } catch {
    return;
  }
}

const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });

async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WORKER_WAIT_MS;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function detachedServerCommand(): { command: string; portFile: string } {
  const portFile = join(h.dir, "server.port");
  const script = join(h.dir, "server.cjs");
  writeFileSync(script, SERVER);
  const start = `(cd /tmp && env -i setsid '${process.execPath}' '${script}' '${portFile}' </dev/null >/dev/null 2>&1 &) &`;
  const wait = `i=0; while [ ! -s '${portFile}' ]; do i=$((i+1)); [ $i -gt 100 ] && { echo "server did not start"; exit 1; }; sleep 0.1; done`;
  return { command: `(${start}) ; ${wait}`, portFile };
}

const dispatchStep = {
  title: "Run a dev server",
  name: "dev-server",
  kind: "ship",
  project: "site",
  intent: "Fix the scrollbar",
  host: "local",
  task: "start the server",
};

async function serverPort(portFile: string): Promise<number> {
  await eventually(() => Promise.resolve(existsSync(portFile)), "the server port file");
  const pid = readFileSync(`${portFile}.pid`, "utf8");
  disarm = guardCleanup(`server-${pid}`, ["sh", "-c", `kill -9 ${pid}`]);
  return Number(readFileSync(portFile, "utf8"));
}

test("close stops a server the worker detached from everything", async () => {
  const { command, portFile } = detachedServerCommand();
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: dispatchStep }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "bash", args: { command } }), "worker");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "server running" } }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Done." } }), "mate");
  await connected(h);
  mate.prompt("run the server");
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  const port = await serverPort(portFile);
  assert.match(results.at(-1) ?? "", /^c-1 is done\./);
  await eventually(async () => !(await listening(port)), "the server to be gone after close");
});

test("restarting a worker stops a server it detached from everything", async () => {
  const { command, portFile } = detachedServerCommand();
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: dispatchStep }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "restart_card", args: { card: 1, key: "again" } }), "mate");
  h.onModel(() => ({ text: "restarted" }), "mate");
  h.onModel(() => ({ tool: "bash", args: { command } }), "worker");
  h.onModel(() => ({ tool: "run_long", args: { label: "wait", command: "sleep 600" } }), "worker");
  h.onModel(() => ({ text: "waiting for the job" }), "worker");
  h.onModel(() => ({ text: "started again" }), "worker");
  await connected(h);
  mate.prompt("run the server");
  const port = await serverPort(portFile);
  await h.waitForCall(2, "mate", WORKER_WAIT_MS);
  mate.prompt("restart it");
  await h.waitForCall(4, "mate", WORKER_WAIT_MS);
  await eventually(async () => !(await listening(port)), "the server to be gone after restart");
});

async function closeStopsJobServer(): Promise<void> {
  const { command, portFile } = detachedServerCommand();
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(() => ({ tool: "dispatch", args: dispatchStep }), "mate");
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(() => ({ tool: "run_long", args: { label: "serve", command } }), "worker");
  h.onModel(() => ({ text: "the job runs" }), "worker");
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "server running" } }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Done." } }), "mate");
  await connected(h);
  mate.prompt("run the server in a job");
  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  const port = await serverPort(portFile);
  assert.match(results.at(-1) ?? "", /^c-1 is done\./);
  await eventually(async () => !(await listening(port)), "the job's server to be gone after close");
}

test("close stops a server that a run_long job detached from everything", closeStopsJobServer);

describe("on a host without a systemd user bus", () => {
  let runtime: string | undefined;
  before(() => {
    runtime = process.env["XDG_RUNTIME_DIR"];
    process.env["XDG_RUNTIME_DIR"] = tempDir("fleet-no-bus-");
  });
  after(() => {
    if (runtime === undefined) delete process.env["XDG_RUNTIME_DIR"];
    else process.env["XDG_RUNTIME_DIR"] = runtime;
  });
  test("close stops a server that a run_long job detached from everything", closeStopsJobServer);
});

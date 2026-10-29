import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "../support/run-root.ts";

const FIXTURE = fileURLToPath(new URL("../support/leak-fixture.ts", import.meta.url));

let outer: string;

beforeEach(() => {
  outer = tempDir("fleet-leak-outer-");
});

afterEach(() => {
  rmSync(outer, { recursive: true, force: true });
});

function runnerOf(mode: string, port: number): ChildProcess {
  const env = {
    ...process.env,
    FLEET_E2E_TMPDIR: outer,
    LEAK_MODE: mode,
    LEAK_REPORT_PORT: String(port),
  };
  Reflect.deleteProperty(env, "NODE_TEST_CONTEXT");
  return spawn("node", ["--test", FIXTURE], {
    env,
    stdio: "ignore",
  });
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else
      child.once("exit", () => {
        resolve();
      });
  });
}

function runToEnd(mode: "pass" | "fail"): Promise<number | null> {
  const child = runnerOf(mode, 0);
  return new Promise((resolve) => child.once("exit", resolve));
}

async function runUntilWaiting(signal: NodeJS.Signals, target: "runner" | "test"): Promise<void> {
  const server = createServer();
  const reported = new Promise<number>((resolve) => {
    server.on("connection", (socket: Socket) => {
      socket.once("data", (data) => {
        resolve(Number(String(data).trim()));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const runner = runnerOf("hang", port);
  const finished = exited(runner);
  const testPid = await reported;
  process.kill(target === "runner" ? (runner.pid ?? 0) : testPid, signal);
  await finished;
  await new Promise((resolve) => server.close(resolve));
  try {
    process.kill(testPid, 0);
    process.kill(testPid, "SIGKILL");
  } catch {
    return;
  }
}

const leftovers = (): string[] => readdirSync(outer);

test("a passing run leaves nothing in its run folder", async () => {
  assert.equal(await runToEnd("pass"), 0);
  assert.deepEqual(leftovers(), []);
});

test("a failing run leaves nothing in its run folder", async () => {
  assert.notEqual(await runToEnd("fail"), 0);
  assert.deepEqual(leftovers(), []);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`a run cancelled with ${signal} leaves nothing in its run folder`, async () => {
    await runUntilWaiting(signal, "test");
    assert.deepEqual(leftovers(), []);
  });
}

test("a run whose runner is interrupted leaves nothing in its run folder", async () => {
  await runUntilWaiting("SIGINT", "runner");
  assert.deepEqual(leftovers(), []);
});

test("a killed run is swept by the next run", async () => {
  await runUntilWaiting("SIGKILL", "test");
  assert.notDeepEqual(leftovers(), []);
  assert.equal(await runToEnd("pass"), 0);
  assert.deepEqual(leftovers(), []);
});

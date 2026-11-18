import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "../support/run-root.ts";

const RUNNER = fileURLToPath(new URL("../run.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../support/suite-fixture.ts", import.meta.url));

function running(pid: number): boolean {
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return state !== "" && !state.startsWith("Z");
  } catch {
    return false;
  }
}

async function launch(t: TestContext, base: string, detached: boolean, files = [FIXTURE]) {
  const server = createServer();
  let socket: Socket | undefined;
  let pid = 0;
  const ready = new Promise<{ root: string; pid: number; release: () => void }>((resolve) => {
    server.once("connection", (connection: Socket) => {
      socket = connection;
      let childPid = "";
      createInterface({ input: connection }).on("line", (line) => {
        if (childPid === "") childPid = line;
        else {
          pid = Number(childPid);
          resolve({ root: line, pid, release: () => connection.end() });
        }
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const env = {
    ...process.env,
    FLEET_E2E_TMPDIR: base,
    FLEET_E2E_CONCURRENCY: "1",
    SUITE_FIXTURE_PORT: String(address.port),
    SUITE_FIXTURE_DETACH: detached ? "1" : "0",
  };
  Reflect.deleteProperty(env, "NODE_TEST_CONTEXT");
  const child = spawn(process.execPath, [RUNNER, ...files], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8").on("data", (data: string) => {
      output += data;
    });
  }
  const result = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  t.after(async () => {
    if (detached && pid > 0 && running(pid)) process.kill(pid, "SIGKILL");
    socket?.destroy();
    child.kill("SIGTERM");
    await result;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  return {
    ready: Promise.race([
      ready,
      result.then(() => {
        throw new Error(output);
      }),
    ]),
    stop: () => child.kill("SIGTERM"),
    result,
    output: () => output,
  };
}

test("cancelling one suite leaves its concurrent peer alone", { timeout: 30_000 }, async (t) => {
  const base = tempDir("suite-");
  const alias = join(tempDir("alias-"), "tmp");
  symlinkSync(base, alias);
  const cancelled = await launch(t, alias, true);
  const peer = await launch(t, alias, false);
  const [left, right] = await Promise.all([cancelled.ready, peer.ready]);
  assert.ok(running(left.pid) && running(right.pid));
  assert.equal(dirname(dirname(left.root)), base);
  assert.equal(dirname(dirname(right.root)), base);
  assert.notEqual(dirname(left.root), dirname(right.root));
  cancelled.stop();
  assert.equal(await cancelled.result, 1, cancelled.output());
  assert.equal(running(left.pid), false, "the detached fixture must be gone");
  assert.equal(existsSync(dirname(left.root)), false);
  assert.ok(running(right.pid), "the peer must still be able to finish");
  right.release();
  assert.equal(await peer.result, 0, peer.output());
  assert.equal(existsSync(dirname(right.root)), false);
});

test("a log setup error still cleans up the suite root", { timeout: 30_000 }, async (t) => {
  const runner = await launch(t, tempDir("suite-"), false, [FIXTURE, FIXTURE]);
  const first = await runner.ready;
  const suite = dirname(first.root);
  mkdirSync(join(suite, "1.log"));
  first.release();
  assert.equal(await runner.result, 1, runner.output());
  assert.match(runner.output(), /(?:EISDIR|EEXIST).*1\.log/);
  assert.equal(existsSync(suite), false);
});

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "../support/run-root.ts";

const RUNNER = fileURLToPath(new URL("../run.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../support/suite-fixture.ts", import.meta.url));
const DIRECT_FIXTURE = fileURLToPath(new URL("../support/direct-fixture.ts", import.meta.url));

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

interface Ready {
  readonly root: string;
  readonly pid: number;
  readonly release: () => void;
}

async function launch(
  t: TestContext,
  base: string,
  mode: "normal" | "detached" | "nested" | "cancelled" | "job" | "late",
  width = 1,
  fileCount = 1,
  extraEnv: Record<string, string> = {},
) {
  const server = createServer();
  const sockets: Socket[] = [];
  const reports = Array.from({ length: width }, () => Promise.withResolvers<Ready>());
  server.on("connection", (connection: Socket) => {
    const report = reports[sockets.length];
    sockets.push(connection);
    let childPid = "";
    createInterface({ input: connection }).on("line", (line) => {
      if (childPid === "") childPid = line;
      else {
        const root: unknown = JSON.parse(line);
        assert.equal(typeof root, "string");
        if (typeof root === "string") {
          report?.resolve({ root, pid: Number(childPid), release: () => connection.end() });
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const env = {
    ...process.env,
    FLEET_E2E_TMPDIR: base,
    FLEET_E2E_CONCURRENCY: String(width),
    SUITE_FIXTURE_PORT: String(address.port),
    SUITE_FIXTURE_MODE: mode,
    ...extraEnv,
  };
  Reflect.deleteProperty(env, "NODE_TEST_CONTEXT");
  const files = Array.from({ length: fileCount }, () => FIXTURE);
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
    for (const socket of sockets) socket.destroy();
    child.kill("SIGTERM");
    await result;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  return {
    ready: async (index = 0): Promise<Ready> => {
      const report = reports[index];
      assert.ok(report !== undefined);
      return Promise.race([
        report.promise,
        result.then(() => {
          throw new Error(output);
        }),
      ]);
    },
    stop: () => child.kill("SIGTERM"),
    result,
    output: () => output,
  };
}

test("cancelling one suite leaves its concurrent peer alone", { timeout: 30_000 }, async (t) => {
  const base = tempDir("suite-");
  const alias = join(tempDir("alias-"), "tmp");
  symlinkSync(base, alias);
  const unrelated = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    detached: true,
    env: {},
    stdio: ["pipe", "ignore", "ignore"],
  });
  const unrelatedExit = once(unrelated, "exit");
  t.after(async () => {
    unrelated.stdin.end();
    await unrelatedExit;
  });
  await once(unrelated, "spawn");
  const unrelatedPid = unrelated.pid;
  assert.ok(unrelatedPid !== undefined && running(unrelatedPid));
  const cancelled = await launch(t, alias, "detached");
  const peer = await launch(t, alias, "normal");
  const [left, right] = await Promise.all([cancelled.ready(), peer.ready()]);
  assert.ok(running(left.pid) && running(right.pid));
  assert.equal(dirname(dirname(left.root)), base);
  assert.equal(dirname(dirname(right.root)), base);
  assert.notEqual(dirname(left.root), dirname(right.root));
  cancelled.stop();
  assert.equal(await cancelled.result, 1, cancelled.output());
  assert.equal(running(left.pid), false, "the detached fixture must be gone");
  assert.ok(running(unrelatedPid), "the unrelated process must still be alive");
  assert.equal(existsSync(dirname(left.root)), false);
  assert.ok(running(right.pid), "the peer must still be able to finish");
  right.release();
  assert.equal(await peer.result, 0, peer.output());
  assert.equal(existsSync(dirname(right.root)), false);
});

test("cancelling a suite reaps a real detached job command", { timeout: 30_000 }, async (t) => {
  const base = tempDir("job-\n-");
  const runner = await launch(t, base, "job");
  const job = await runner.ready();
  assert.ok(running(job.pid));
  runner.stop();
  assert.equal(await runner.result, 1, runner.output());
  assert.equal(running(job.pid), false);
  assert.equal(existsSync(dirname(job.root)), false);
});

test("cancelling a containing suite removes its nested workers", { timeout: 30_000 }, async (t) => {
  const base = tempDir("suite-");
  const runner = await launch(t, base, "nested");
  const nested = await runner.ready();
  const innerSuite = dirname(nested.root);
  const outerSuite = dirname(dirname(innerSuite));
  assert.equal(dirname(outerSuite), base);
  assert.ok(running(nested.pid));
  runner.stop();
  assert.equal(await runner.result, 1, runner.output());
  assert.equal(running(nested.pid), false, "the nested detached fixture must be gone");
  assert.equal(existsSync(outerSuite), false);
});

test("a log setup error drains active lanes before removing the suite", { timeout: 30_000 }, async (t) => {
  const width = availableParallelism() >= 32 ? 2 : 1;
  const runner = await launch(t, tempDir("suite-"), "detached", width, width + 1);
  const first = await runner.ready();
  const other = width === 2 ? await runner.ready(1) : undefined;
  const suite = dirname(first.root);
  const blocked = `${String(width)}.log`;
  mkdirSync(join(suite, blocked));
  if (other !== undefined) assert.ok(running(other.pid));
  first.release();
  assert.equal(await runner.result, 1, runner.output());
  const output = runner.output();
  const fault = output.search(/(?:EISDIR|EEXIST).*\.log/);
  assert.ok(fault >= 0 && output.slice(fault).includes(blocked), output);
  if (other !== undefined) {
    assert.equal(running(other.pid), false, "the other lane's detached process must be gone");
    const drained = output.indexOf(`swept after ${FIXTURE}: ${String(other.pid)} `);
    assert.ok(drained >= 0 && drained < fault, output);
  }
  assert.equal(existsSync(suite), false);
});

test("the runner rejects a private base under a replaceable ancestor", (t) => {
  const shared = tempDir("shared-");
  const base = join(shared, "base");
  chmodSync(shared, 0o777);
  t.after(() => chmodSync(shared, 0o700));
  assert.throws(
    () => execFileSync(process.execPath, [RUNNER, FIXTURE], {
      env: { ...process.env, FLEET_E2E_TMPDIR: base, FLEET_E2E_CONCURRENCY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    /replaceable end-to-end directory/,
  );
  assert.equal(existsSync(base), false);
});

test("the suite counts tests cancelled by Node", { timeout: 30_000 }, async (t) => {
  const runner = await launch(t, tempDir("suite-"), "cancelled");
  assert.equal(await runner.result, 1, runner.output());
  assert.match(runner.output(), /1 files, 1 tests, 0 passed, 0 failed, 1 cancelled, 0 skipped/);
});

test("a launcher that starts after cleanup closed the registry never runs its command", { timeout: 30_000 }, async (t) => {
  const mark = join(tempDir("late-"), "started");
  const runner = await launch(t, tempDir("suite-"), "late", 1, 1, { SUITE_FIXTURE_MARK: mark });
  assert.equal(await runner.result, 0, runner.output());
  assert.equal(existsSync(mark), false, "the late command ran outside any registry");
});

test("a killed direct run's reaper finishes owned teardown before its root is removed", { timeout: 40_000 }, async (t) => {
  const base = tempDir("direct-");
  const alive = join(base, "hook-saw-root");
  const server = createServer();
  const lines: string[] = [];
  const announced = Promise.withResolvers<{ pid: number; root: string }>();
  server.on("connection", (connection: Socket) => {
    createInterface({ input: connection }).on("line", (line) => {
      lines.push(line);
      const [pid, root] = lines;
      if (pid !== undefined && root !== undefined) {
        announced.resolve({ pid: Number(pid), root: String(JSON.parse(root)) });
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const env = {
    ...process.env,
    FLEET_E2E_TMPDIR: base,
    DIRECT_FIXTURE_PORT: String(address.port),
    DIRECT_FIXTURE_MARK: alive,
  };
  for (const name of ["FLEET_E2E_ROOT", "FLEET_E2E_GROUPS", "FLEET_E2E_LAB_GROUPS", "NODE_TEST_CONTEXT"])
    Reflect.deleteProperty(env, name);
  const fixture = spawn(process.execPath, [DIRECT_FIXTURE], { env, stdio: "ignore" });
  const exited = once(fixture, "exit");
  t.after(async () => {
    fixture.kill("SIGKILL");
    await exited;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  const { pid, root } = await Promise.race([
    announced.promise,
    exited.then(() => {
      throw new Error("the direct fixture exited before it announced");
    }),
  ]);
  assert.ok(running(pid) && existsSync(root));
  fixture.kill("SIGTERM");
  await exited;
  for (const deadline = Date.now() + 30_000; running(pid) || existsSync(root); ) {
    assert.ok(Date.now() < deadline, `the registered process or ${root} outlived teardown`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(readFileSync(alive, "utf8").trim(), "alive");
});

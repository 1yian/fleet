import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { spawnOwned } from "./marked.ts";

const port = Number(process.env["SUITE_FIXTURE_PORT"]);
const root = process.env["FLEET_E2E_ROOT"] ?? "";

const mode = process.env["SUITE_FIXTURE_MODE"];
const options = mode === "cancelled" ? { timeout: 50 } : {};
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const announce = `const socket = require('node:net').connect(${String(port)}, '127.0.0.1');
  socket.on('connect', () => socket.write(process.pid + '\\n' + ${JSON.stringify(JSON.stringify(root))} + '\\n'));`;

test("wait for the controlling test", options, async (t) => {
  if (mode === "cancelled") {
    await delay(30_000, undefined, { signal: t.signal });
  } else if (mode === "nested") {
    const runner = fileURLToPath(new URL("../run.ts", import.meta.url));
    const env = { ...process.env, FLEET_E2E_TMPDIR: root, SUITE_FIXTURE_MODE: "detached" };
    Reflect.deleteProperty(env, "NODE_TEST_CONTEXT");
    const child = spawnOwned(process.execPath, [runner, fileURLToPath(import.meta.url)], {
      env,
      stdio: "ignore",
    });
    await once(child, "exit");
  } else if (mode === "job") {
    const job = fileURLToPath(new URL("../../packages/extension/src/job.ts", import.meta.url));
    const input = join(root, "job.json");
    writeFileSync(input, JSON.stringify({
      url: "http://127.0.0.1:1",
      token: "fixture",
      job: 1,
      command: `exec ${quote(process.execPath)} -e ${quote(`process.kill(process.ppid, 'SIGKILL'); ${announce}`)}`,
      timeoutMs: 60_000,
      heartbeatMs: 60_000,
    }));
    const child = spawn(process.execPath, [job, input], { stdio: "inherit" });
    const [, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    if (signal !== "SIGKILL") throw new Error(`job fixture exited by ${String(signal)}`);
    await delay(60_000, undefined, { signal: t.signal });
  } else if (mode === "detached") {
    const child = spawnOwned(process.execPath, ["-e", announce], { stdio: "ignore" });
    await once(child, "exit");
  } else if (mode === "late") {
    const mark = process.env["SUITE_FIXTURE_MARK"] ?? "";
    const owned = fileURLToPath(new URL("./owned-launch.ts", import.meta.url));
    const later = `require('node:fs').writeFileSync(${JSON.stringify(`${mark}.ready`)}, '1'); setTimeout(() => {
      const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(owned)}, process.execPath, '-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'started'); setInterval(() => undefined, 1e6)`)}], { detached: true, stdio: 'ignore' });
      child.unref();
    }, 1500);`;
    spawnOwned(process.execPath, ["-e", later], { stdio: "ignore" }).unref();
    for (const deadline = Date.now() + 10_000; !existsSync(`${mark}.ready`); ) {
      if (Date.now() > deadline) throw new Error("the registered process never started");
      await delay(20);
    }
  } else {
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(`${String(process.pid)}\n${JSON.stringify(root)}\n`);
    await once(socket, "end");
  }
});

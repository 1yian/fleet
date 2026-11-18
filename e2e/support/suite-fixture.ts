import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const port = Number(process.env["SUITE_FIXTURE_PORT"]);
const root = process.env["FLEET_E2E_ROOT"] ?? "";

const mode = process.env["SUITE_FIXTURE_MODE"];
const options = mode === "cancelled" ? { timeout: 50 } : {};

test("wait for the controlling test", options, async (t) => {
  if (mode === "cancelled") {
    await delay(30_000, undefined, { signal: t.signal });
  } else if (mode === "nested") {
    const runner = fileURLToPath(new URL("../run.ts", import.meta.url));
    const env = { ...process.env, FLEET_E2E_TMPDIR: root, SUITE_FIXTURE_MODE: "detached" };
    Reflect.deleteProperty(env, "NODE_TEST_CONTEXT");
    const child = spawn(process.execPath, [runner, fileURLToPath(import.meta.url)], {
      env,
      detached: true,
      stdio: "ignore",
    });
    await once(child, "exit");
  } else if (mode === "detached") {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const socket = require('node:net').connect(${String(port)}, '127.0.0.1');
         socket.on('connect', () => socket.write(process.pid + '\\n' + ${JSON.stringify(root)} + '\\n'));`,
      ],
      { detached: true, stdio: "ignore" },
    );
    await once(child, "exit");
  } else {
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(`${String(process.pid)}\n${root}\n`);
    await once(socket, "end");
  }
});

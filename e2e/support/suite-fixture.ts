import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { test } from "node:test";

const port = Number(process.env["SUITE_FIXTURE_PORT"]);
const root = process.env["FLEET_E2E_ROOT"] ?? "";

test("wait for the controlling test", async () => {
  if (process.env["SUITE_FIXTURE_DETACH"] === "1") {
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

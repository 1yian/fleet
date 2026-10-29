import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { test } from "node:test";
import { Harness } from "../support/harness.ts";

test(
  "a probe handshake arriving during shutdown is rejected, not parsed as a model request",
  { timeout: 30_000 },
  async (t) => {
    const h = await Harness.start();
    const url = new URL(h.piEnv("default")["FLEET_CONTROL_URL"] ?? "");
    const socket = connect(Number(url.port), url.hostname);
    t.after(async () => {
      socket.destroy();
      await h.stop();
    });
    socket.setEncoding("utf8");
    let reply = "";
    let failure = "";
    socket.on("data", (chunk: string) => (reply += chunk));
    socket.on("error", (error: NodeJS.ErrnoException) => (failure = error.code ?? error.message));
    const closed = new Promise((resolve) => socket.once("close", resolve));
    await once(socket, "connect");

    const pi = h.startPi("late-probe");
    pi.prompt("hello");
    await h.waitFor((event) => event["type"] === "settled", "Pi to answer");
    assert.deepEqual((await h.waitForCall(0)).at(-1), { role: "user", text: "hello" });
    await pi.kill();

    socket.write("GET /probe HTTP/1.1\r\nHost: localhost\r\n");
    const stopped = h.stop();
    socket.end(
      `Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`,
    );
    await closed;
    await stopped;
    assert.ok(
      reply.startsWith("HTTP/1.1 404 ") || (reply === "" && failure === "ECONNRESET"),
      `the handshake got neither a 404 nor a reset: ${JSON.stringify({ reply, failure })}`,
    );
    assert.equal(h.calls.length, 1);
  },
);

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocketServer } from "ws";
import { Harness } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const WAIT_MS = 30_000;

let h: Harness;
let oldCardd: WebSocketServer;
let hellos = 0;
beforeEach(async () => {
  h = await Harness.start();
  hellos = 0;
  oldCardd = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  oldCardd.on("connection", (socket) => {
    socket.on("message", () => {
      hellos += 1;
      socket.send(JSON.stringify({ t: "welcome" }));
    });
  });
  await new Promise((resolve) => oldCardd.once("listening", resolve));
});
afterEach(async () => {
  await h.stop();
  for (const client of oldCardd.clients) client.terminate();
  await new Promise((resolve) => {
    oldCardd.close(resolve);
  });
});

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a mate that gets a server message it cannot read stays alive, says so once, and keeps reconnecting", async () => {
  const address = oldCardd.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const env = {
    FLEET_URL: `ws://127.0.0.1:${String(port)}/session`,
    FLEET_TOKEN: "old-token",
    FLEET_ROLE: "mate",
  };
  let context = "";
  h.onModel((turns) => {
    context = turns
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.text)
      .join("\n");
    return { text: "still here" };
  });
  const mate = h.startPi("cleo", env, [EXTENSION]);

  await until(() => hellos >= 3, "the mate to say hello three times");
  mate.prompt("Are you there?");
  await h.waitForCall(0);

  assert.equal(
    context,
    [
      "[fleet] link: cardd sent a message this session cannot read (invalid : must have required properties session, role, lowWater). It may run other code than this extension. The session keeps reconnecting.",
      "Are you there?",
    ].join("\n"),
  );
});

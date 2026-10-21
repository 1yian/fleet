import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocketServer } from "ws";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const PAUSE_MS = 30 * 60_000;

let fleet: Fleet | undefined;
let newerCardd: WebSocketServer | undefined;
let h: Harness;
beforeEach(async () => {
  h = await Harness.start();
});
afterEach(async () => {
  await h.stop();
  await fleet?.cardd.stop();
  fleet = undefined;
  if (newerCardd === undefined) return;
  for (const client of newerCardd.clients) client.terminate();
  const closing = newerCardd;
  newerCardd = undefined;
  await new Promise((resolve) => {
    closing.close(resolve);
  });
});

const toolResults = (turns: Turn[]): string[] =>
  turns.filter((turn) => turn.role === "toolResult").map((turn) => turn.text);

type Args = Readonly<Record<string, string | number | boolean>>;

async function boardCalls(
  env: Record<string, string>,
  calls: readonly Args[],
  lane: string,
): Promise<string[]> {
  for (const args of calls) h.onModel(() => ({ tool: "board", args }));
  h.onModel(() => ({ text: "read" }));
  const mate = h.startPi(lane, { ...env, FLEET_ROLE: "mate" }, [EXTENSION]);
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("What is on the board?");
  return toolResults(await h.waitForCall(calls.length));
}

test("a lane's mate lists another lane's paused card, with the time it waits until", async () => {
  fleet = await startFleet();
  const cnpToken = fleet.cardd.addLane("cnp", "main");
  const leo = await fleet.cardd.connect(fleet.cardd.addLane("leo", "main"));
  const card = await newCard(leo, "Wait for CI");
  const worker = await fleet.cardd.connect(await begin(leo, card));
  await worker.call("report", {
    status: "paused",
    text: "CI runs",
    until: Date.now() + PAUSE_MS,
  });
  const env = { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: cnpToken };

  const [whole, laneOnly, pausedOnly] = await boardCalls(
    env,
    [{}, { lane: "leo" }, { status: "paused" }],
    "cnp",
  );

  assert.match(whole ?? "", /^open: "3 \(paused 1, waiting 2\)"$/m);
  const row = /^ {2}3,paused \(in (29|30)m\),worker,no-mistakes,Wait for CI$/m;
  assert.match(laneOnly ?? "", /^lane: leo$/m);
  assert.match(laneOnly ?? "", row);
  assert.match(pausedOnly ?? "", row);
  await Promise.all([leo.close(), worker.close()]);
});

test("a session that cannot read cardd's board says it runs other code and how to restart it", async () => {
  newerCardd = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  newerCardd.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message: unknown = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : "null");
      if (typeof message !== "object" || message === null) return;
      if ("t" in message && message.t === "hello")
        socket.send(JSON.stringify({ t: "welcome", session: "cnp", role: "mate", lowWater: 0 }));
      if ("t" in message && message.t === "call" && "id" in message)
        socket.send(
          JSON.stringify({
            t: "result",
            id: message.id,
            ok: true,
            value: [
              {
                id: 29,
                name: "wait-for-ci",
                title: "Wait for CI",
                lane: "leo",
                project: null,
                kind: "ship",
                status: "napping",
                revision: 1,
                pr: null,
                delivery: null,
                intent: "",
                spec: "",
                createdAt: 1,
                updatedAt: 1,
                summary: "",
                mate: false,
                holder: null,
                replies: [],
                attention: null,
                pausedUntil: null,
                activity: null,
              },
            ],
          }),
        );
    });
  });
  await new Promise((resolve) => newerCardd?.once("listening", resolve));
  const address = newerCardd.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const env = { FLEET_URL: `ws://127.0.0.1:${String(port)}/session`, FLEET_TOKEN: "cnp-token" };

  const [whole, laneOnly] = await boardCalls(env, [{}, { lane: "leo" }], "cnp");

  const unreadable =
    'cardd\'s answer to board cannot be read by this session (invalid /0/status: must be equal to one of the allowed values). This session runs other code than cardd, most likely loaded before an update: restart this session so it loads the current code (main: lane(<lane>, "restart")).';
  assert.equal(whole, unreadable);
  assert.equal(laneOnly, unreadable);
});

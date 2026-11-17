import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { check, OPS, parseClientMessage, type Card } from "@fleet/protocol";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { Harness, type Pi, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const QUESTION = "Did anything about the system annoy you?";
const SENTENCE = "The worker prompt never says where the evidence folder is.";

let fleet: Fleet;
let h: Harness;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
  card = await newCard(fleet.main, "Users see one scrollbar");
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

async function worker(url = fleet.cardd.url): Promise<Pi> {
  const token = await begin(fleet.main, card, "the task");
  const env = { FLEET_URL: url, FLEET_TOKEN: token, FLEET_ROLE: "worker" };
  return h.startPi(`c-${String(card.id)}-a1`, env, [EXTENSION]);
}
const rawText = (data: RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString();
  return data.toString();
};
const sendWhenReady = async (
  ready: Promise<void>,
  upstream: WebSocket,
  text: string,
): Promise<void> => {
  await ready;
  upstream.send(text);
};
const asked = (turns: Turn[] | undefined): number =>
  (turns ?? []).filter((turn) => turn.role === "user" && turn.text.includes(QUESTION)).length;
const toolResults = (turns: Turn[] | undefined): string[] =>
  (turns ?? []).filter((turn) => turn.role === "toolResult").map((turn) => turn.text);
const recorded = async () => check(OPS.complaints.result, await fleet.main.call("complaints", {}));
const settled = (n: number) =>
  h.waitForNth((e) => e["type"] === "settled", n, `settle ${String(n)}`);

for (const final of ["done", "blocked", "failed"]) {
  test(`a worker sees the question before its ${final} handoff and records feedback first`, async () => {
    h.onModel(() => ({ tool: "report", args: { status: "working", text: "setup done" } }));
    h.onModel(() => ({ tool: "complain", args: { text: SENTENCE } }));
    h.onModel(async () => {
      const prompt =
        h.calls[0]
          ?.filter((turn) => turn.role === "system")
          .map((turn) => turn.text)
          .join("\n") ?? "";
      assert.match(prompt, /Did anything about the system annoy you\?/);
      assert.match(prompt, /wait for its result, then send the final report/);
      assert.equal((await recorded())[0]?.text, SENTENCE);
      return { tool: "report", args: { status: final, text: "handing off" } };
    });
    h.onModel(() => ({ text: "finished" }));
    await worker();
    await settled(1);

    assert.equal(h.calls.length, 4);
    assert.deepEqual(
      h.calls.map(asked),
      [0, 0, 0, 0],
      "the role context supplies the question without a post-handoff steer",
    );
    assert.equal(toolResults(h.calls[2]).at(-1), "Recorded complaint 1.");
    assert.deepEqual(
      (await recorded()).map(({ text, session, role, lane, card: on, project }) => ({
        text,
        session,
        role,
        lane,
        on,
        project,
      })),
      [
        {
          text: SENTENCE,
          session: `c-${String(card.id)}-a1`,
          role: "worker",
          lane: "main",
          on: card.id,
          project: "web",
        },
      ],
    );
    assert.deepEqual(
      fleet.main.entries.map(({ entry }) => [entry.fields["status"], entry.body]),
      [
        ["working", "setup done"],
        [final, "handing off"],
      ],
    );
    assert.equal(await status(fleet.main, card), "with-mate");
  });
}

test("an open connection that never answers complain times out, warns, and still permits the handoff", async (t) => {
  const proxy = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => proxy.once("listening", resolve));
  let received = 0;
  const upstreams: WebSocket[] = [];
  proxy.on("connection", (client) => {
    const upstream = new WebSocket(fleet.cardd.url);
    const ready = new Promise<void>((resolve) => upstream.once("open", resolve));
    client.on("message", (data) => {
      const text = rawText(data);
      const message = parseClientMessage(text);
      if (message.t === "call" && message.op === "complain") {
        received += 1;
        return;
      }
      void sendWhenReady(ready, upstream, text);
    });
    upstream.on("message", (data) => {
      client.send(rawText(data));
    });
    client.on("close", () => {
      upstream.close();
    });
    upstreams.push(upstream);
  });
  t.after(() => {
    for (const upstream of upstreams) upstream.terminate();
  });
  t.after(() => {
    for (const client of proxy.clients) client.terminate();
    proxy.close();
  });
  const address = proxy.address();
  if (typeof address === "string" || address === null) throw new Error("no proxy address");
  let started = 0;
  h.onModel(() => {
    started = Date.now();
    return { tool: "complain", args: { text: SENTENCE } };
  });
  h.onModel(() => {
    assert.ok(Date.now() - started >= 4_500);
    assert.ok(Date.now() - started < 10_000);
    return { tool: "report", args: { status: "failed", text: "the build is broken" } };
  });
  h.onModel(() => ({ text: "finished" }));
  const pi = await worker(`ws://127.0.0.1:${String(address.port)}`);
  await fleet.main.waitForEntries(1);
  const warning = await pi.waitForUi(
    (request) => String(request["message"]).includes("complaint was dropped"),
    "the dropped-complaint warning",
  );
  await settled(1);

  assert.equal(warning["notifyType"], "warning");
  assert.equal(received, 1);
  assert.match(String(warning["message"]), /cardd did not answer in time/);
  assert.match(toolResults(h.calls[1]).at(-1) ?? "", /^Not recorded: cardd did not take it/);
  assert.deepEqual(await recorded(), []);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(
    fleet.main.entries.map(({ entry }) => [entry.fields["status"], entry.body]),
    [["failed", "the build is broken"]],
  );
});

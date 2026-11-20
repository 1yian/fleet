import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { CLOSE, parseServerMessage, type Card } from "@fleet/protocol";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { Harness, poll, type Pi, type Turn } from "../support/harness.ts";
import { parseRecord } from "../support/json.ts";

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
const filed = () => fleet.cardd.gh.issues();
const filedBy = (count: number) =>
  poll(() => (filed().length >= count ? filed() : undefined), `${String(count)} filed issue(s)`);
const settled = (n: number) =>
  h.waitForNth((e) => e["type"] === "settled", n, `settle ${String(n)}`);

for (const final of ["done", "blocked", "failed"]) {
  test(`a worker can report ${final} while its complaint filing is pending`, async (t) => {
    const release = fleet.cardd.gh.holdIssues();
    t.after(release);
    h.onModel(() => ({ tool: "report", args: { status: "working", text: "setup done" } }));
    h.onModel(() => ({ tool: "complain", args: { text: SENTENCE } }));
    h.onModel(() => {
      const prompt =
        h.calls[0]
          ?.filter((turn) => turn.role === "system")
          .map((turn) => turn.text)
          .join("\n") ?? "";
      assert.match(prompt, /Did anything about the system annoy you\?/);
      assert.match(
        prompt,
        /Before a final `done`, `blocked`, or `failed`, ask yourself once:[^\n]+`complain` once, then report/,
      );
      return { tool: "report", args: { status: final, text: "handing off" } };
    });
    h.onModel(() => ({ text: "finished" }));
    await worker();
    await settled(1);
    await fleet.main.waitForEntries(2);

    assert.equal(h.calls.length, 4);
    assert.deepEqual(
      h.calls.map(asked),
      [0, 0, 0, 0],
      "the role context supplies the question without a post-handoff steer",
    );
    assert.equal(
      toolResults(h.calls[2]).at(-1),
      "Accepted by cardd for filing as a GitHub issue. Carry on.",
    );
    assert.deepEqual(
      fleet.main.entries.map(({ entry }) => [entry.fields["status"], entry.body]),
      [
        ["working", "setup done"],
        [final, "handing off"],
      ],
    );
    assert.equal(await status(fleet.main, card), "with-mate");
    await poll(() => fleet.cardd.gh.calls()[0], "the pending GitHub call");
    assert.deepEqual(filed(), []);
    release();

    assert.deepEqual(
      (await filedBy(1)).map(({ repo, title, body }) => ({
        repo,
        title,
        details: body
          .split("\n")
          .filter((line) => line.startsWith("- ") && !line.startsWith("- Time: ")),
      })),
      [
        {
          repo: "github.com/1yian/fleet",
          title: SENTENCE,
          details: [
            "- Role: worker",
            "- Lane: `main`",
            `- Card: c-${String(card.id)}`,
            "- Project: `web`",
          ],
        },
      ],
    );
  });
}

for (const mode of ["a lost acknowledgement", "a legacy server"]) {
  test(`${mode} warns without retrying and still permits the handoff`, async (t) => {
    const proxy = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => proxy.once("listening", resolve));
    const received: string[] = [];
    const upstreams: WebSocket[] = [];
    proxy.on("connection", (client) => {
      const upstream = new WebSocket(fleet.cardd.url);
      const ready = new Promise<void>((resolve) => upstream.once("open", resolve));
      const unacknowledged = new Set<number>();
      client.on("message", (data) => {
        const text = rawText(data);
        const { t: kind, id, op } = parseRecord(text);
        if (
          kind === "call" &&
          typeof id === "number" &&
          (op === "complain" || op === "complaint.publish")
        ) {
          received.push(op);
          if (mode === "a legacy server") {
            if (op === "complain")
              client.send(JSON.stringify({ t: "result", id, ok: true, value: { id: 1 } }));
            else client.close(CLOSE.badMessage, "invalid operation");
            return;
          }
          unacknowledged.add(id);
        }
        void sendWhenReady(ready, upstream, text);
      });
      upstream.on("message", (data) => {
        const text = rawText(data);
        const message = parseServerMessage(text);
        if (message.t !== "result" || !unacknowledged.delete(message.id)) client.send(text);
      });
      client.on("close", () => {
        upstream.close();
      });
      upstreams.push(upstream);
    });
    t.after(() => {
      for (const upstream of upstreams) upstream.terminate();
      for (const client of proxy.clients) client.terminate();
      proxy.close();
    });
    const address = proxy.address();
    if (typeof address === "string" || address === null) throw new Error("no proxy address");
    h.onModel(() => ({ tool: "complain", args: { text: SENTENCE } }));
    h.onModel(() => ({ tool: "report", args: { status: "failed", text: "the build is broken" } }));
    h.onModel(() => ({ text: "finished" }));
    const pi = await worker(`ws://127.0.0.1:${String(address.port)}`);
    await fleet.main.waitForEntries(1);
    const warning = await pi.waitForUi(
      (request) => String(request["message"]).includes("complaint handoff unconfirmed"),
      "the unconfirmed complaint warning",
    );
    await settled(1);

    assert.equal(warning["notifyType"], "warning");
    assert.deepEqual(received, ["complaint.publish"]);
    assert.match(
      String(warning["message"]),
      mode === "a legacy server" ? /cardd closed the connection/ : /cardd did not answer in time/,
    );
    assert.equal(
      toolResults(h.calls[1]).at(-1),
      "Complaint handoff unconfirmed. It may still be filed. Carry on.",
    );
    if (mode === "a legacy server") assert.deepEqual(fleet.cardd.gh.calls(), []);
    else
      assert.deepEqual(
        (await filedBy(1)).map(({ title }) => title),
        [SENTENCE],
      );
    assert.equal(h.calls.length, 3);
    assert.deepEqual(
      fleet.main.entries.map(({ entry }) => [entry.fields["status"], entry.body]),
      [["failed", "the build is broken"]],
    );
  });
}

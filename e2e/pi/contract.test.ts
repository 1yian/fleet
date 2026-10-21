import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { gate, Harness, type Pi, type Turn } from "../support/harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await Harness.start();
});
afterEach(async () => {
  await h.stop();
});

const said = (turns: Turn[]): string[] => turns.map((turn) => `${turn.role}: ${turn.text}`);

async function sessionFile(): Promise<string> {
  const event = await h.waitFor((e) => e["type"] === "session", "session start");
  const file = event["file"];
  if (typeof file !== "string") throw new Error("session start reported no file");
  return file;
}

async function queueDuringToolCall(sessionId: string): Promise<{ pi: Pi; file: string }> {
  const pi = h.startPi(sessionId);
  const file = await sessionFile();
  h.onModel(() => ({ tool: "slow_tool" }));
  pi.prompt("start");
  await h.waitFor((e) => e["type"] === "tool_waiting", "the tool call");
  h.send(101, "followUp", "[fleet] #101 older follow-up");
  h.send(102, "steer", "[fleet] #102 newer steer");
  await h.waitFor((e) => e["type"] === "sent" && e["entryId"] === 102, "both messages queued");
  return { pi, file };
}

test("a newer steer overtakes an older follow-up", async () => {
  const { file } = await queueDuringToolCall("overtake");
  h.releaseTool();
  await h.waitFor((e) => e["type"] === "settled", "settle");

  assert.deepEqual(said(await h.waitForCall(1)).slice(-2), [
    "toolResult: slow tool done",
    "user: [fleet] #102 newer steer",
  ]);
  assert.deepEqual(said(await h.waitForCall(2)).slice(-3), [
    "user: [fleet] #102 newer steer",
    "assistant: ok",
    "user: [fleet] #101 older follow-up",
  ]);
  assert.deepEqual(Harness.fleetEntriesInFile(file), [102, 101]);
});

test("a crash after the steer reached the model keeps it on disk and loses the follow-up", async () => {
  const { pi, file } = await queueDuringToolCall("crash-between");
  const held = gate();
  h.onModel(async () => {
    await held.wait;
    return { text: "never sent" };
  });
  h.releaseTool();
  assert.deepEqual(said(await h.waitForCall(1)).at(-1), "user: [fleet] #102 newer steer");

  assert.deepEqual(Harness.fleetEntriesInFile(file), [102]);
  await pi.kill();
  assert.deepEqual(Harness.fleetEntriesInFile(file), [102]);
  held.open();
});

test("before the first model reply, the session file does not exist", async () => {
  const pi = h.startPi("lazy-file");
  const file = await sessionFile();
  const held = gate();
  h.onModel(async () => {
    await held.wait;
    return { text: "never sent" };
  });
  h.send(201, "followUp", "[fleet] #201 task message");
  assert.deepEqual(said(await h.waitForCall(0)).at(-1), "user: [fleet] #201 task message");
  await h.waitFor((e) => e["type"] === "message_end" && e["entryId"] === 201, "message end");

  await pi.kill();
  assert.deepEqual(Harness.fleetEntriesInFile(file), []);
  held.open();
});

test("agent_before_settle can continue the run once with a nudge", async () => {
  const pi = h.startPi("nudge", { PROBE_NUDGE: "1" });
  await sessionFile();
  pi.prompt("hello");
  await h.waitFor((e) => e["type"] === "settled", "settle");

  assert.deepEqual(said(await h.waitForCall(1)).slice(-2), ["assistant: ok", "user: nudge"]);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(
    h.events.filter((e) => e["type"] === "before_settle" || e["type"] === "settled"),
    [
      { type: "before_settle", pending: 0 },
      { type: "before_settle", pending: 0 },
      { type: "settled", aborted: false },
    ],
  );
});

test("agent_settled reports an abort", async () => {
  const pi = h.startPi("abort");
  await sessionFile();
  const held = gate();
  h.onModel(async () => {
    await held.wait;
    return { text: "too late" };
  });
  pi.prompt("hello");
  await h.waitForCall(0);
  pi.abort();

  assert.deepEqual(await h.waitFor((e) => e["type"] === "settled", "settle"), {
    type: "settled",
    aborted: true,
  });
  held.open();
});

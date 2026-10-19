// A real worker: Pi with the fleet extension and the scripted model, connected
// to a real cardd. The mate is a test session. Spec sections 9, 12.3, and 25.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Card, Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { gate, Harness, type Pi, type Turn } from "../support/harness.ts";

// Entry IDs in a fresh cardd: the first, second, and third comment.
const [START, OLDER, NEWER] = [1, 2, 3];
const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
let card: Card;
let env: Record<string, string>;
beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
  card = await newCard(fleet.main, "Users see one scrollbar");
  env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: await begin(fleet.main, card),
    FLEET_ROLE: "worker",
  };
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

const worker = (): Pi => h.startPi(`c-${String(card.id)}-a1`, env, [EXTENSION]);
const comment = (text: string, now = false): Promise<unknown> =>
  fleet.main.call("comment", { card: card.id, text, now });
const fleetText = (text: string): string => `[fleet] main on c-${String(card.id)}: ${text}`;
const lastUser = (turns: Turn[]): string | undefined =>
  turns.findLast((turn) => turn.role === "user")?.text;
const count = (turns: Turn[], text: string): number =>
  turns.filter((turn) => turn.text === text).length;
const reports = (mate: Session): [unknown, string, unknown][] =>
  mate.entries.map(({ entry }: { entry: Entry }) => [
    entry.fields["status"],
    entry.body,
    entry.fields["re"],
  ]);
async function sessionFile(): Promise<string> {
  const file = (await h.waitFor((e) => e["type"] === "session", "session start"))["file"];
  if (typeof file !== "string") throw new Error("no session file");
  return file;
}
const delivered = (id: number) => (event: Record<string, unknown>) =>
  event["type"] === "fleet_delivered" && event["entryId"] === id;

test("a comment wakes an idle worker, and its report reaches the mate", async () => {
  worker();
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "PR green and ready" } }));
  await comment("fix the scrollbar");
  await fleet.main.waitForEntries(1);

  assert.equal(lastUser(await h.waitForCall(0)), fleetText("fix the scrollbar"));
  assert.deepEqual(reports(fleet.main), [["done", "PR green and ready", "fix the scrollbar"]]);
  assert.equal(await status(fleet.main, card), "needs-you");
});

test("a run that ends without a handoff gets one nudge, then files stopped", async () => {
  worker();
  h.onModel(() => ({ text: "I looked around" }));
  h.onModel(() => ({ text: "still looking" }));
  await comment("investigate the scrollbar");
  await fleet.main.waitForEntries(1);

  assert.match(
    lastUser(await h.waitForCall(1)) ?? "",
    /^\[fleet\] Your run is ending without a handoff/,
  );
  assert.equal(h.calls.length, 2);
  assert.deepEqual(reports(fleet.main), [
    ["stopped", "ended the run without a handoff: still looking", "investigate the scrollbar"],
  ]);
  assert.equal(await status(fleet.main, card), "with-mate");
});

test("a worker woken from a pause is nudged and stopped when it ends a run on a progress report", async () => {
  worker();
  h.onModel(() => ({ tool: "report", args: { status: "paused", text: "waiting for CI" } }));
  h.onModel(() => ({ text: "waiting" }));
  await comment("start");
  await fleet.main.waitForEntries(1);
  await h.waitFor((e) => e["type"] === "settled", "the paused run to settle");
  assert.equal(h.calls.length, 2);

  h.onModel(() => ({ tool: "report", args: { status: "working", text: "back at it" } }));
  h.onModel(() => ({ text: "that is all" }));
  h.onModel(() => ({ text: "still nothing" }));
  await comment("any news?");
  await fleet.main.waitForEntries(3);

  assert.match(
    lastUser(await h.waitForCall(4)) ?? "",
    /^\[fleet\] Your run is ending without a handoff/,
  );
  assert.deepEqual(reports(fleet.main), [
    ["paused", "waiting for CI", "start"],
    ["working", "back at it", "any news?"],
    ["stopped", "ended the run without a handoff: still nothing", undefined],
  ]);
});

test("a run stopped from the pane files stopped", async () => {
  const pi = worker();
  const held = gate();
  h.onModel(async () => {
    await held.wait;
    return { text: "too late" };
  });
  await comment("investigate the scrollbar");
  await h.waitForCall(0);
  pi.abort();
  await fleet.main.waitForEntries(1);
  held.open();

  assert.deepEqual(reports(fleet.main), [
    ["stopped", "stopped from the pane", "investigate the scrollbar"],
  ]);
});

test("after a crash, recovery delivers the older follow-up once and never repeats the newer steer", async () => {
  const pi = worker();
  h.onModel(() => ({ tool: "slow_tool" }));
  await comment("start");
  await h.waitFor((e) => e["type"] === "tool_waiting", "the tool call");
  await comment("older follow-up");
  await comment("newer steer", true);
  await h.waitFor(delivered(OLDER), "the follow-up queued");
  await h.waitFor(delivered(NEWER), "the steer queued");
  const held = gate();
  h.onModel(async () => {
    await held.wait;
    return { text: "never sent" };
  });
  h.releaseTool();
  await h.waitFor(
    (e) => e["type"] === "message_end" && e["entryId"] === NEWER,
    "the steer in the context",
  );
  assert.equal(lastUser(await h.waitForCall(1)), fleetText("newer steer"));
  await pi.kill();
  held.open();

  h.onModel(() => ({ tool: "report", args: { status: "done", text: "done after the crash" } }));
  worker();
  await fleet.main.waitForEntries(1);
  const after = await h.waitForCall(2);
  assert.equal(lastUser(after), fleetText("older follow-up"));
  assert.equal(count(after, fleetText("older follow-up")), 1);
  assert.equal(count(after, fleetText("newer steer")), 1);
  assert.deepEqual(reports(fleet.main), [["done", "done after the crash", "newer steer"]]);
});

test("a message lost before the session file existed is delivered again after a crash", async () => {
  const pi = worker();
  const held = gate();
  h.onModel(async () => {
    await held.wait;
    return { text: "never sent" };
  });
  await comment("the task message");
  assert.equal(lastUser(await h.waitForCall(0)), fleetText("the task message"));
  await h.waitFor(delivered(START), "the task message delivered");
  await pi.kill();
  held.open();

  h.onModel(() => ({ tool: "report", args: { status: "done", text: "done" } }));
  worker();
  await fleet.main.waitForEntries(1);
  const after = await h.waitForCall(1);
  assert.deepEqual(
    after.filter((turn) => turn.role === "user").map((turn) => turn.text),
    [fleetText("the task message")],
  );
});

test("a cardd restart does not repeat a message the worker already holds", async () => {
  worker();
  h.onModel(() => ({ tool: "slow_tool" }));
  await comment("start");
  await h.waitFor((e) => e["type"] === "tool_waiting", "the tool call");
  await comment("older follow-up");
  await h.waitFor(delivered(OLDER), "the follow-up queued");
  await fleet.cardd.restart();
  const main = await fleet.cardd.connect(fleet.mainToken);
  await h.waitForNth((e) => e["type"] === "fleet_connected", 2, "the worker to reconnect");

  h.releaseTool();
  await h.waitFor((e) => e["type"] === "settled", "the run to settle");
  await main.call("board", {});

  assert.equal(count(h.calls.at(-1) ?? [], fleetText("older follow-up")), 1);
  assert.deepEqual(Harness.fleetEntriesInFile(await sessionFile()), [START, OLDER]);
});

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Card } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const SUPERSEDING_PR = "https://github.com/acme/web/pull/420";
const UNRECORDED_PR = "https://github.com/acme/web/pull/421";
const OPTIONS = ["Approve the apply", "Do not apply"];
const WHY = "The cancelled run changed nothing and PR 420 replaced it.";

let fleet: Fleet;
let h: Harness;
beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

const toolResults = (turns: Turn[]): string[] =>
  turns.filter((turn) => turn.role === "toolResult").map((turn) => turn.text);

async function runMain(calls: number): Promise<string[]> {
  h.onModel(() => ({ text: "handled" }));
  h.startPi(
    "main",
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: fleet.mainToken, FLEET_ROLE: "mate" },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "main to connect");
  return toolResults(await h.waitForCall(calls + 1));
}

const retire = (card: Card, extra: Record<string, unknown>) => ({
  tool: "hold",
  args: { card: card.id, clear: true, retire: WHY, ...extra },
});

async function finishedWithPr(cleo: Session, title: string, pr: string): Promise<Card> {
  const card = await newCard(cleo, title);
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await worker.call("report", { status: "done", text: "PR ready", pr });
  return card;
}

test("a mate retires a stale captain hold with evidence, and every attempt to dodge a live decision is refused", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const stale = await newCard(cleo, "Review the apply of PR 417", "scout");
  const worker = await fleet.cardd.connect(await begin(cleo, stale));
  await worker.call("report", { status: "needs-decision", key: "apply", text: "Apply PR 417?" });
  await cleo.call("hold", {
    card: stale.id,
    question: "Approve the risky apply?",
    options: OPTIONS,
  });
  await fleet.main.call("hold", {
    card: stale.id,
    to: "captain",
    question: "Apply?",
    options: OPTIONS,
  });
  assert.equal(await status(cleo, stale), "needs-you");
  await assert.rejects(
    cleo.call("release", { card: stale.id, retire: { reason: WHY, supersededBy: 99 } }),
    { message: `c-${String(stale.id)} waits on the captain, so only main retires it: ask main` },
  );

  const superseding = await finishedWithPr(cleo, "Apply PR 420", SUPERSEDING_PR);
  const merging = await finishedWithPr(cleo, "Ship the docs", "https://github.com/acme/web/pull/9");
  const unlanded = await newCard(cleo, "Preserved branch");
  const unlandedWorker = await fleet.cardd.connect(await begin(cleo, unlanded));
  await cleo.call("hold", { card: unlanded.id, question: "Which host?", options: OPTIONS });
  await unlandedWorker.call("report", {
    status: "done",
    text: "PR ready",
    pr: "https://github.com/acme/web/pull/11",
  });
  await cleo.call("hold", { card: unlanded.id, question: "Keep or discard it?", options: OPTIONS });

  const dropped = await newCard(cleo, "Abandoned idea");
  await cleo.call("close.finish", {
    card: dropped.id,
    mode: "dropped",
    text: "not wanted",
    archives: [],
    left: [],
  });

  const id = String(stale.id);
  h.onModel(() => retire(stale, {}));
  h.onModel(() => ({ tool: "hold", args: { card: stale.id, clear: true, supersededBy: 1 } }));
  h.onModel(() => retire(stale, { supersededBy: stale.id }));
  h.onModel(() => retire(stale, { supersededBy: UNRECORDED_PR }));
  h.onModel(() => retire(stale, { supersededBy: dropped.id }));
  h.onModel(() => retire(stale, { supersededBy: superseding.id, choice: "Approve the apply" }));
  h.onModel(() => retire(stale, { supersededBy: superseding.id, note: "Approved." }));
  h.onModel(() => retire(merging, { supersededBy: superseding.id }));
  h.onModel(() => retire(unlanded, { supersededBy: superseding.id }));
  h.onModel(() => retire(stale, { supersededBy: SUPERSEDING_PR }));
  const results = await runMain(10);

  assert.match(results[0] ?? "", /retiring a hold needs both retire/);
  assert.match(results[1] ?? "", /retiring a hold needs both retire/);
  assert.equal(results[2], `c-${id} cannot supersede its own hold`);
  assert.equal(results[3], `no card has recorded ${UNRECORDED_PR}, so it supersedes nothing`);
  assert.equal(results[4], `c-${String(dropped.id)} was dropped, so it supersedes nothing`);
  assert.match(results[5] ?? "", /retiring a hold picks no option and records no approval/);
  assert.match(
    results[6] ?? "",
    /exactly one of the captain's exact words, your own note, or retire/,
  );
  assert.match(results[7] ?? "", /merge question: only the captain's approval answers it/);
  assert.match(results[8] ?? "", /stays the captain's call: it cannot be retired/);
  assert.equal(results[9], `Cleared. c-${id} is now with-mate.`);

  assert.equal(await status(cleo, merging), "with-mate");
  assert.equal(await status(cleo, unlanded), "with-mate");
  const board = await fleet.cardd.board();
  assert.deepEqual(board.holds.map((hold) => hold.card).sort(), []);
  const { entries } = await fleet.cardd.thread(stale.id);
  assert.ok(!entries.some((entry) => entry.kind === "answer"));
  const retired = entries.filter((entry) => entry.kind === "release");
  assert.equal(retired.length, 1);
  assert.equal(retired[0]?.author, "mate:main");
  assert.equal(retired[0]?.fields["retired"], true);
  assert.equal(retired[0]?.fields["supersededBy"], SUPERSEDING_PR);
  assert.match(retired[0]?.body ?? "", /^Retired as obsolete, not approved or decided\. /);
  assert.match(retired[0]?.body ?? "", /PR 420 replaced it\./);
  const mergeThread = (await fleet.cardd.thread(merging.id)).entries;
  assert.ok(mergeThread.some((entry) => entry.kind === "hold" && entry.fields["merge"] === true));
  assert.ok(!mergeThread.some((entry) => entry.kind === "release" || entry.kind === "answer"));
});

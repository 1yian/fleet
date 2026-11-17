import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Card } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const PR = "https://github.com/acme/web/pull/255";
const CAPTAIN_WORDS = "Just delete it";
const OPTIONS = ["Discard it", "Keep it"];

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

async function holdForMain(cleo: Session, title: string): Promise<{ card: Card; worker: Session }> {
  const card = await newCard(cleo, title);
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await cleo.call("hold", {
    card: card.id,
    question: "Which host should run the checks?",
    options: OPTIONS,
  });
  return { card, worker };
}

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

const refusal = (card: Card): string =>
  `c-${String(card.id)} holds finished work that has not landed, so whether to keep, land, or discard it is the captain's call: escalate it with hold(card, to="captain", question, options), or clear it with his exact words`;

test("rewriting a finished PR's hold reserves disposition for captain words", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const { card, worker } = await holdForMain(cleo, "Restore the stock worker browser");
  await worker.call("report", { status: "done", text: "PR ready", pr: PR });
  await cleo.call("hold", {
    card: card.id,
    question: "Keep or discard the preserved work?",
    options: OPTIONS,
  });
  assert.equal(await status(cleo, card), "with-mate");
  assert.equal(await fleet.cardd.act(card.id, { kind: "comment", text: CAPTAIN_WORDS }), 200);

  h.onModel(() => ({ tool: "hold", args: { card: card.id, clear: true, note: "Preserve it." } }));
  h.onModel(() => ({
    tool: "hold",
    args: { card: card.id, to: "captain", question: "Keep or discard it?", options: OPTIONS },
  }));
  h.onModel(() => ({ tool: "hold", args: { card: card.id, clear: true, note: "Keep it." } }));
  h.onModel(() => ({
    tool: "hold",
    args: { card: card.id, clear: true, words: CAPTAIN_WORDS },
  }));
  const results = await runMain(4);
  assert.equal(results[0], refusal(card));
  assert.equal(results[1], `Held. c-${String(card.id)} is now needs-you.`);
  assert.equal(
    results[2],
    `c-${String(card.id)} waits on the captain: clear it with his exact words`,
  );
  assert.match(results[3] ?? "", new RegExp(`^Cleared\\. c-${String(card.id)} is now `));

  const { entries } = await fleet.cardd.thread(card.id);
  assert.ok(!entries.some((entry) => entry.kind === "release"));
  assert.deepEqual(
    entries
      .filter((entry) => entry.kind === "hold")
      .map((entry) => entry.fields["unlanded"] === true),
    [false, true, true, false],
  );
  assert.equal(entries.at(-1)?.fields["merge"], true);
  const answer = entries.find((entry) => entry.kind === "answer");
  assert.equal(answer?.body, CAPTAIN_WORDS);
  assert.equal(answer.fields["source"], "record");
});

test("explicit PR-less disposition marks survive identical rewrites and refuse main's note", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const { card, worker } = await holdForMain(cleo, "Preserved branch without a PR");
  await worker.call("report", { status: "done", text: "Work preserved, PR creation failed" });
  const question = "Keep or discard the preserved branch?";
  await cleo.call("hold", { card: card.id, question, options: OPTIONS });
  await cleo.call("hold", { card: card.id, question, options: OPTIONS, unlanded: true });
  await cleo.call("hold", { card: card.id, question, options: OPTIONS, unlanded: false });
  h.onModel(() => ({ tool: "hold", args: { card: card.id, clear: true, note: "Discard it." } }));
  const results = await runMain(1);
  assert.equal(results[0], refusal(card));
  const { entries } = await fleet.cardd.thread(card.id);
  assert.ok(!entries.some((entry) => entry.kind === "release"));
  assert.deepEqual(
    entries
      .filter((entry) => entry.kind === "hold")
      .map((entry) => entry.fields["unlanded"] === true),
    [false, false, true],
  );
});

test("operational holds remain main's to note-clear before and after worker completion", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const finished = await holdForMain(cleo, "Post-build checks");
  await finished.worker.call("report", { status: "done", text: "PR ready", pr: PR });
  const unfinished = await holdForMain(cleo, "Ads exports");
  for (const { card } of [finished, unfinished]) {
    h.onModel(() => ({ tool: "hold", args: { card: card.id, clear: true, note: "Use P620." } }));
  }
  const results = await runMain(2);
  for (const [index, { card }] of [finished, unfinished].entries()) {
    assert.match(results[index] ?? "", new RegExp(`^Cleared\\. c-${String(card.id)} is now `));
    const { entries } = await fleet.cardd.thread(card.id);
    const released = entries.find((entry) => entry.kind === "release");
    assert.equal(released?.body, "Use P620.");
    assert.equal(released.author, "mate:main");
  }
});

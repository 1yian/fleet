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

async function holdForMain(
  cleo: Session,
  title: string,
  question: string,
  finish: boolean,
): Promise<Card> {
  const card = await newCard(cleo, title);
  const worker = await fleet.cardd.connect(await begin(cleo, card));
  await cleo.call("hold", { card: card.id, question, options: OPTIONS });
  if (finish) await worker.call("report", { status: "done", text: "PR ready", pr: PR });
  return card;
}

test("main cannot clear a second mate's hold on finished unlanded work with its own note: it escalates, and the captain's words clear it, while an operational hold still clears with a note", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const unlanded = await holdForMain(
    cleo,
    "Restore the stock worker browser",
    "PR 255 will not merge. Keep or discard the preserved work?",
    true,
  );
  const operational = await holdForMain(
    cleo,
    "Ads exports",
    "Which API version should the export use?",
    false,
  );
  assert.equal(await status(cleo, unlanded), "with-mate");
  assert.equal(await status(cleo, operational), "with-mate");
  assert.equal(await fleet.cardd.act(unlanded.id, { kind: "comment", text: CAPTAIN_WORDS }), 200);

  h.onModel(() => ({
    tool: "hold",
    args: { card: unlanded.id, clear: true, note: "Preserve it for now." },
  }));
  h.onModel(() => ({
    tool: "hold",
    args: {
      card: unlanded.id,
      to: "captain",
      question: "Keep or discard the preserved work of PR 255? I recommend discard.",
      options: OPTIONS,
    },
  }));
  h.onModel(() => ({
    tool: "hold",
    args: { card: unlanded.id, clear: true, note: "Preserve it anyway." },
  }));
  h.onModel(() => ({
    tool: "hold",
    args: { card: unlanded.id, clear: true, words: CAPTAIN_WORDS },
  }));
  h.onModel(() => ({
    tool: "hold",
    args: { card: operational.id, clear: true, note: "Use v2, the spec says so." },
  }));
  h.onModel(() => ({ text: "handled" }));
  h.startPi(
    "main",
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: fleet.mainToken, FLEET_ROLE: "mate" },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "main to connect");

  const results = toolResults(await h.waitForCall(6));
  assert.equal(
    results[0],
    `c-${String(unlanded.id)} holds finished work that has not landed, so whether to keep, land, or discard it is the captain's call: escalate it with hold(card, to="captain", question, options), or clear it with his exact words`,
  );
  assert.equal(results[1], `Held. c-${String(unlanded.id)} is now needs-you.`);
  assert.equal(
    results[2],
    `c-${String(unlanded.id)} waits on the captain: clear it with his exact words`,
  );
  assert.match(results[3] ?? "", new RegExp(`^Cleared\\. c-${String(unlanded.id)} is now `));
  assert.match(results[4] ?? "", new RegExp(`^Cleared\\. c-${String(operational.id)} is now `));

  const kinds = async (card: Card): Promise<string[]> =>
    (await fleet.cardd.thread(card.id)).entries.map((entry) => entry.kind);
  const unlandedKinds = await kinds(unlanded);
  assert.ok(!unlandedKinds.includes("release"));
  assert.deepEqual(
    unlandedKinds.filter((kind) => kind === "hold" || kind === "answer").slice(0, 3),
    ["hold", "hold", "answer"],
  );
  const answer = (await fleet.cardd.thread(unlanded.id)).entries.find(
    (entry) => entry.kind === "answer",
  );
  assert.equal(answer?.body, CAPTAIN_WORDS);
  assert.equal(answer.fields["source"], "record");
  const released = (await fleet.cardd.thread(operational.id)).entries.find(
    (entry) => entry.kind === "release",
  );
  assert.equal(released?.body, "Use v2, the spec says so.");
});

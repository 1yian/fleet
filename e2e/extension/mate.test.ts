// A real mate Pi with the fleet extension (spec sections 9.6 and 17.3). answer
// accepts the captain's words only when the captain said them.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

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

test("answer records the captain's words only when the captain said them", async () => {
  const cleo = fleet.cardd.addLane("cleo", "main");
  h.onModel(() => ({
    tool: "card_new",
    args: { title: "Pick the API version", name: "api-version", kind: "captain" },
  }));
  h.onModel(() => ({ tool: "ask", args: { card: 1, question: "v1 or v2?", options: "v2" } }));
  h.onModel(() => ({ tool: "answer", args: { card: 1, words: "use v3" } }));
  h.onModel(() => ({ tool: "answer", args: { card: 1, words: "use the v2 endpoint" } }));
  h.onModel(() => ({ text: "recorded" }));
  const mate = h.startPi(
    "cleo",
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: cleo, FLEET_ROLE: "mate" },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("Make a card for the API version and ask me. My answer: use the v2 endpoint.");

  const results = toolResults(await h.waitForCall(4));
  assert.deepEqual(results.slice(1), [
    "Asked. c-1 is now with-first-mate.",
    "these words are not in the captain's messages or board entries; quote the captain exactly",
    "Recorded the answer. c-1 is now with-mate.",
  ]);
});

test("grant records a grant only with the captain's words", async () => {
  h.onModel(() => ({
    tool: "grant",
    args: { lane: "main", words: "merge anything", may: "merge", merge: true },
  }));
  h.onModel(() => ({
    tool: "grant",
    args: { lane: "main", words: "merge when CI is green", may: "merge", merge: true },
  }));
  h.onModel(() => ({ text: "recorded" }));
  const mate = h.startPi(
    "main",
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: fleet.mainToken, FLEET_ROLE: "mate" },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("You may merge when CI is green.");

  assert.deepEqual(toolResults(await h.waitForCall(2)), [
    "these words are not in the captain's messages or board entries; quote the captain exactly",
    "Recorded the grant.",
  ]);
});

// A real mate Pi with the fleet extension (spec sections 9.6 and 17.3). release
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

test("release records the captain's words only when the captain said them", async () => {
  const cleo = fleet.cardd.addLane("cleo", "main");
  h.onModel(() => ({
    tool: "card_new",
    args: { title: "Pick the API version", name: "api-version", kind: "captain" },
  }));
  h.onModel(() => ({ tool: "hold", args: { card: 2, question: "v1 or v2?", options: "v2" } }));
  h.onModel(() => ({ tool: "release", args: { card: 2, words: "use v3" } }));
  h.onModel(() => ({ tool: "release", args: { card: 2, words: "use the v2 endpoint" } }));
  h.onModel(() => ({ text: "recorded" }));
  const mate = h.startPi(
    "cleo",
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: cleo, FLEET_ROLE: "mate" },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  mate.prompt(
    "Make a card for the API version and hold it for me. My answer: use the v2 endpoint.",
  );

  const results = toolResults(await h.waitForCall(4));
  assert.deepEqual(results.slice(1), [
    "Held. c-2 is now with-mate.",
    "these words are not in the captain's messages or board entries; quote the captain exactly",
    "Released. c-2 is now with-mate.",
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

test("main hands work to a second mate with comment(lane), and card_new refuses the lane", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  h.onModel(() => ({
    tool: "card_new",
    args: { title: "Ads stay under budget", name: "ads-budget", kind: "scout", lane: "cleo" },
  }));
  h.onModel(() => ({
    tool: "comment",
    args: { lane: "cleo", text: "The captain asks: keep ads under budget" },
  }));
  h.onModel(() => ({ text: "handed over" }));
  const mate = h.startPi(
    "main",
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: fleet.mainToken, FLEET_ROLE: "mate" },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("Hand the ad budget work to cleo.");

  const results = toolResults(await h.waitForCall(2));
  assert.match(
    results[0] ?? "",
    /^card_new cannot create a card in lane cleo\. To hand work to cleo/,
  );
  assert.equal(results[1], "Commented. c-1 [waiting] cleo");
  const heard = await cleo.waitForEntry((entry) => entry.author === "mate:main", "main's comment");
  assert.equal(heard.body, "The captain asks: keep ads under budget");
});

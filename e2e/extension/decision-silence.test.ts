import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { startFleet, type Fleet } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
});
afterEach(async () => {
  const stopped = await Promise.allSettled([h.stop(), fleet.cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function contractOf(name: string, token: string): Promise<string> {
  h.onModel(() => ({ text: "aye" }));
  const mate = h.startPi(
    name,
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "mate" },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("Good morning.");
  const turns = await h.waitForCall(0);
  return turns.find((turn) => turn.role === "system")?.text ?? "";
}

const RULE = "A waiting decision shows on his status bar and on its card, so chat stays silent";
const EXCEPTIONS =
  "Two exceptions only: he asks what waits, and you answer him plainly, and interruption 4";
const ONE_AT_A_TIME = "Decisions reach the captain one at a time on his card, never as a list";
const STALL =
  "Interruption 4 leads with the evidence of the stall, names the decision, and says why it stalls work. It does not tell him how to open the card";
const CHAT_YES =
  "When the captain answers in chat, call `hold(card, clear=true, words=<his exact words>)`";

for (const [lane, who] of [
  ["main", "main"],
  ["cleo", "a second mate"],
] as const) {
  test(`${who} is never told to say /d, and its contract keeps chat silent about waiting decisions`, async () => {
    const token = lane === "main" ? fleet.mainToken : fleet.cardd.addLane("cleo", "main");
    const contract = await contractOf(lane, token);

    assert.ok(/^# Firstmate$/m.test(contract), "the mate received its role contract");
    assert.deepEqual(
      contract.match(/.{0,100}\/d\b.{0,60}/g) ?? [],
      [],
      "the contract never names /d, so it never tells the mate to say it",
    );
    assert.ok(contract.includes(RULE), "the contract states that chat stays silent");
    assert.ok(contract.includes(EXCEPTIONS), "the contract names the two exceptions");
    assert.ok(
      contract.includes(ONE_AT_A_TIME),
      "decisions still reach him one at a time on the card",
    );
    assert.ok(contract.includes(STALL), "interruption 4 states the stall and gives no instruction");
    assert.ok(contract.includes(CHAT_YES), "a chat yes still clears a hold with his words");
  });
}

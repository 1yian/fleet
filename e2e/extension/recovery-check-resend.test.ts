import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Entry } from "@fleet/protocol";
import { startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { missedAbout, untakenControl } from "../support/missed.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const SUMMARIZER_DOWN = "provider exploded: code 61";
const SUMMARY_PROMPT = "ONLY output the structured summary";
const BIG = "lorem ipsum dolor ".repeat(8000);

let fleet: Fleet;
let h: Harness;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.02" });
  h = await Harness.start();
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

const isSummary = (turns: Turn[]): boolean =>
  turns.some((turn) => turn.text.includes(SUMMARY_PROMPT));
const isFailure = (entry: Entry): boolean => entry.fields["condition"] === "runtime-failure";

async function compactingMate(summarizerUp: () => boolean): Promise<void> {
  const token = fleet.cardd.addLane("cleo", "main");
  for (let call = 0; call < 30; call += 1)
    h.onModel((turns) => {
      if (!isSummary(turns)) return { text: "ok" };
      return summarizerUp() ? { text: "a summary" } : { fail: SUMMARIZER_DOWN };
    }, "cleo");
  const env = { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "mate" };
  const cleo = h.startPi("cleo", { ...env, FLEET_FAKE_AGENT: "cleo" }, [EXTENSION]);
  for (let turn = 1; turn <= 3; turn += 1) {
    cleo.prompt(`${BIG}${String(turn)}`);
    await h.waitForNth((event) => event["type"] === "settled", turn, "the turn to settle");
  }
}

test("a compaction recovery check that verified is not resent, recompacted, or reported missed", async () => {
  let summarizerUp = false;
  await compactingMate(() => summarizerUp);
  const heard = await fleet.main.waitForEntry(isFailure, "the compaction failure");
  const [, incident, generation] =
    /Incident (\d+), process generation (\d+)/.exec(heard.body) ?? [];
  const compactionsBefore = h.callsOf("cleo").filter(isSummary).length;
  summarizerUp = true;

  await fleet.main.call("card.restart", {
    card: heard.card,
    incident: Number(incident),
    generation: Number(generation),
    mode: "retry",
    key: "retry",
  });
  const recovered = await fleet.main.waitForEntry(
    (entry) => entry.body.includes("recovered (retry)"),
    "the compaction recovery to verify",
  );
  assert.match(recovered.body, /compacted its conversation successfully/);

  const control = await untakenControl(fleet, "A task nobody takes in");
  await control.reportedMissed();

  assert.deepEqual(missedAbout(fleet, heard.card), []);
  assert.equal(h.callsOf("cleo").filter(isSummary).length, compactionsBefore + 1);
  assert.equal(
    h
      .callsOf("cleo")
      .flat()
      .filter((turn) => turn.text.includes("sent again")).length,
    0,
    "the recovery check was sent to the model again",
  );
  await control.worker.close();
});

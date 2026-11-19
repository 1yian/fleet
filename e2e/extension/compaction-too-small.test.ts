import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardViewSchema, check, type Entry } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { gate, Harness, type Pi } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const SUMMARIZER_DOWN = "provider exploded: code 61";
const EARLIER_FAILURE = "Compaction failed: Summarization failed: provider exploded: code 52";
const BIG = "lorem ipsum dolor ".repeat(8000);
const WAIT_MS = 30_000;

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

const isFailure = (entry: Entry): boolean => entry.fields["condition"] === "runtime-failure";

function incidents(): { state: string; phase: string; error: string }[] {
  const db = new DatabaseSync(fleet.cardd.db, { readOnly: true, timeout: 5000 });
  try {
    return db
      .prepare("SELECT state, phase, error FROM incidents ORDER BY id")
      .all()
      .map((row) => ({
        state: String(row["state"]),
        phase: String(row["phase"]),
        error: String(row["error"]),
      }));
  } finally {
    db.close();
  }
}

async function untilStates(expected: string[]): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const found = incidents().map((each) => each.state);
    if (found.join() === expected.join()) return;
    if (Date.now() > deadline) assert.deepEqual(found, expected);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function tinyWorker(hold?: Promise<void>): Promise<{ pi: Pi; token: string; card: number }> {
  for (let call = 0; call < 30; call += 1)
    h.onModel(async (turns) => {
      if (turns.some((turn) => turn.text.includes("ONLY output the structured summary")))
        return { fail: SUMMARIZER_DOWN };
      await hold;
      return { text: "ok" };
    });
  const card = await newCard(fleet.main, "Users see one scrollbar");
  const token = await begin(fleet.main, card);
  const env = { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" };
  const pi = h.startPi(`c-${String(card.id)}-a1`, env, [EXTENSION]);
  await h.waitFor((event) => event["type"] === "fleet_connected", "the worker to connect");
  await h.waitForCall(0);
  if (hold === undefined)
    await h.waitForNth((event) => event["type"] === "settled", 1, "the assignment turn to settle");
  return { pi, token, card: card.id };
}

async function compactsNothing(pi: Pi): Promise<void> {
  pi.compact();
  const response = await pi.compactResponse();
  assert.equal(response["success"], false);
  assert.equal(response["error"], "Nothing to compact (session too small)");
}

async function earlierFailure(token: string): Promise<Entry> {
  const reported = await fleet.cardd.post(token, "incident.report", {
    error: EARLIER_FAILURE,
    phase: "compaction",
  });
  assert.equal(reported.status, 200);
  return fleet.main.waitForEntry(isFailure, "the earlier compaction failure");
}

test("a worker whose session is too small to compact raises no incident, and a real compaction failure after it still raises one", async () => {
  const { pi } = await tinyWorker();
  await compactsNothing(pi);
  for (let turn = 1; turn <= 3; turn += 1) {
    pi.prompt(`${BIG}${String(turn)}`);
    await h.waitForNth((event) => event["type"] === "settled", turn + 1, "the turn to settle");
  }
  const heard = await fleet.main.waitForEntry(isFailure, "the real compaction failure");

  assert.match(
    heard.body,
    new RegExp(
      `^runtime failure: the worker on c-1 its conversation compaction failed: Auto-compaction failed: Summarization failed: ${SUMMARIZER_DOWN}\\.`,
    ),
  );
  assert.match(heard.body, /Incident 1, process generation 1\./);
  assert.deepEqual(
    incidents().map((each) => [each.state, each.phase]),
    [["open", "compaction"]],
  );
  assert.deepEqual(fleet.main.entries.map((push) => push.entry).filter(isFailure), [heard]);
});

test("a compaction that finds nothing to compact closes an incident that is already open", async () => {
  const { pi, token } = await tinyWorker();
  await earlierFailure(token);
  await untilStates(["open"]);

  await compactsNothing(pi);

  await untilStates(["cleared"]);
});

test("a compaction recovery check on a session too small to compact is verified, not failed", async () => {
  const held = gate();
  const { token, card } = await tinyWorker(held.wait);
  const turns = h.calls.length;
  const heard = await earlierFailure(token);
  const found = /Incident (\d+), process generation (\d+)/.exec(heard.body);

  await fleet.main.call("card.restart", {
    card,
    incident: Number(found?.[1]),
    generation: Number(found?.[2]),
    mode: "retry",
    key: "retry",
  });
  await untilStates(["verified"]);

  const bodies = check(CardViewSchema, await fleet.main.call("card", { card })).entries.map(
    (entry) => entry.body,
  );
  assert.ok(bodies.some((body) => body.includes("recovered (retry)")));
  assert.equal(bodies.filter((body) => body.includes("did not verify")).length, 0);
  assert.equal(h.calls.length, turns);
  held.open();
});

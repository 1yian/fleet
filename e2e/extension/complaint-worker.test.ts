import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS, type Card } from "@fleet/protocol";
import { begin, newCard, startFleet, status, type Fleet } from "../support/fleet.ts";
import { Harness, type Pi, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const QUESTION = "Did anything about the system annoy you?";
const SENTENCE = "The worker prompt never says where the evidence folder is.";

let fleet: Fleet;
let h: Harness;
let card: Card;
beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
  card = await newCard(fleet.main, "Users see one scrollbar");
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

async function worker(): Promise<Pi> {
  const token = await begin(fleet.main, card, "the task");
  const env = { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" };
  return h.startPi(`c-${String(card.id)}-a1`, env, [EXTENSION]);
}
const asked = (turns: Turn[] | undefined): number =>
  (turns ?? []).filter((turn) => turn.role === "user" && turn.text.includes(QUESTION)).length;
const toolResults = (turns: Turn[] | undefined): string[] =>
  (turns ?? []).filter((turn) => turn.role === "toolResult").map((turn) => turn.text);
const recorded = async () => check(OPS.complaints.result, await fleet.main.call("complaints", {}));
const settled = (n: number) =>
  h.waitForNth((e) => e["type"] === "settled", n, `settle ${String(n)}`);

test("a worker is asked only at a final handoff, only once per run, and never again after it complains", async () => {
  h.onModel(() => ({ tool: "report", args: { status: "working", text: "setup done" } }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "all green" } }));
  h.onModel(() => ({ tool: "complain", args: { text: SENTENCE } }));
  h.onModel(() => ({ tool: "report", args: { status: "done", text: "still all green" } }));
  h.onModel(() => ({ text: "finished" }));
  await worker();
  await settled(1);

  assert.equal(h.calls.length, 5);
  assert.deepEqual(
    h.calls.map(asked),
    [0, 0, 1, 1, 1],
    "the question comes once, after the first final handoff",
  );
  assert.equal(toolResults(h.calls[3]).at(-1), "Recorded complaint 1.");
  assert.deepEqual(
    (await recorded()).map(({ text, session, role, lane, card: on, project }) => ({
      text,
      session,
      role,
      lane,
      on,
      project,
    })),
    [
      {
        text: SENTENCE,
        session: `c-${String(card.id)}-a1`,
        role: "worker",
        lane: "main",
        on: card.id,
        project: "web",
      },
    ],
  );
  assert.deepEqual(
    fleet.main.entries.map(({ entry }) => [entry.fields["status"], entry.body]),
    [
      ["working", "setup done"],
      ["done", "all green"],
      ["done", "still all green"],
    ],
  );
  assert.equal(await status(fleet.main, card), "with-mate");
});

test("a worker that cannot reach cardd to complain drops the complaint with a warning and still finishes", async () => {
  h.onModel(() => ({ tool: "report", args: { status: "failed", text: "the build is broken" } }));
  h.onModel(async () => {
    await fleet.cardd.stop();
    return { tool: "complain", args: { text: SENTENCE } };
  });
  h.onModel(() => ({ text: "finished" }));
  const pi = await worker();
  await fleet.main.waitForEntries(1);
  const warning = await pi.waitForUi(
    (request) => String(request["message"]).includes("complaint was dropped"),
    "the dropped-complaint warning",
  );
  await settled(1);

  assert.equal(warning["notifyType"], "warning");
  assert.equal(asked(h.calls[1]), 1);
  assert.match(toolResults(h.calls[2]).at(-1) ?? "", /^Not recorded: cardd did not take it/);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(
    fleet.main.entries.map(({ entry }) => [entry.fields["status"], entry.body]),
    [["failed", "the build is broken"]],
  );
});

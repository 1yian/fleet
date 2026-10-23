import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Pi } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const SUMMARY_MARKER = "ONLY output the structured summary";
const BIG = "lorem ipsum dolor ".repeat(8000);
const COMPACT_WAIT_MS = 30_000;
const TURNS = 5;

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

const isSummary = (turns: readonly { text: string }[]): boolean =>
  turns.some((turn) => turn.text.includes(SUMMARY_MARKER));

async function startAs(role: "mate" | "worker", agent: string, model: string[]): Promise<Pi> {
  const token =
    role === "worker"
      ? await begin(fleet.main, await newCard(fleet.main, "the task"), "the task")
      : fleet.cardd.addLane(agent, "main");
  const env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: token,
    FLEET_ROLE: role,
    FLEET_FAKE_AGENT: agent,
  };
  return h.startPi(`${agent}-session`, env, [EXTENSION], model);
}

async function summaryModel(
  role: "mate" | "worker",
  model: string[],
  trigger: "manual" | "automatic",
): Promise<string> {
  const agent = `${role}-${trigger}`;
  for (let call = 0; call < 40; call += 1)
    h.onModel((turns) => {
      if (turns.some((turn) => turn.text.includes(SUMMARY_MARKER))) return { text: "a summary" };
      return { text: "ok" };
    }, agent);
  const earlier = h.events.filter((event) => event["type"] === "settled").length;
  const pi = await startAs(role, agent, model);
  for (let turn = 1; turn <= TURNS; turn += 1) {
    pi.prompt(`${BIG}${String(turn)}`);
    await h.waitForNth(
      (event) => event["type"] === "settled",
      earlier + turn,
      "the turn to settle",
    );
    if (trigger === "automatic" && h.callsOf(agent).some(isSummary)) break;
  }
  if (trigger === "manual") pi.compact();
  return summarizingModel(agent);
}

async function summarizingModel(agent: string): Promise<string> {
  const deadline = Date.now() + COMPACT_WAIT_MS;
  for (;;) {
    const at = h
      .callsOf(agent)
      .findIndex((turns) => turns.some((turn) => turn.text.includes(SUMMARY_MARKER)));
    const model = h.modelsOf(agent)[at];
    if (at >= 0 && model !== undefined) return model;
    if (Date.now() > deadline)
      throw new Error(`no compaction call arrived from ${agent}: ${h.modelsOf(agent).join()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const VERTEX = ["--provider", "google-vertex", "--model", "gemini-2.5-pro"];

test("a worker's compaction runs on tier/compact, not on its session model", async () => {
  assert.equal(await summaryModel("worker", [], "manual"), "tier/compact");
  assert.equal(await summaryModel("worker", [], "automatic"), "tier/compact");
});

test("a mate's compaction runs on tier/compact, not on its session model", async () => {
  assert.equal(await summaryModel("mate", [], "manual"), "tier/compact");
  assert.equal(await summaryModel("mate", [], "automatic"), "tier/compact");
});

test("a CNP-style mate on Vertex compacts on Vertex and never on tier/compact", async () => {
  assert.equal(await summaryModel("mate", VERTEX, "manual"), "google-vertex/gemini-2.5-flash");
  assert.equal(await summaryModel("mate", VERTEX, "automatic"), "google-vertex/gemini-2.5-flash");
  assert.ok(!h.modelsOf("mate-manual").includes("tier/compact"));
  assert.ok(!h.modelsOf("mate-automatic").includes("tier/compact"));
});

test("a CNP-style worker on Vertex compacts on Vertex and never on tier/compact", async () => {
  assert.equal(await summaryModel("worker", VERTEX, "manual"), "google-vertex/gemini-2.5-flash");
  assert.ok(!h.modelsOf("worker-manual").includes("tier/compact"));
});

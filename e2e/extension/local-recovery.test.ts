import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import type { Card } from "@fleet/protocol";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
let fleet: Fleet;
let h: Harness;
let card: Card;
let file: string;

beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
  card = await newCard(fleet.main, "Correct the local label");
  mkdirSync(join(h.dir, "work"));
  file = join(h.dir, "work", "label.txt");
  writeFileSync(file, "label=original\n");
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

async function worker(): Promise<void> {
  const token = await begin(fleet.main, card, "Correct the label, verifying the result.");
  h.startPi(
    `c-${String(card.id)}-a1`,
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" },
    [EXTENSION],
    [],
    true,
  );
  await fleet.main.waitForEntries(1);
  await h.waitFor((event) => event["type"] === "settled", "the worker to settle");
}

const result = (turns: Turn[]): string =>
  turns.filter((turn) => turn.role === "toolResult").at(-1)?.text ?? "";
const edit = (oldText: string, newText: string) => ({
  tool: "edit",
  args: { path: "label.txt", oldText, newText },
});
const reports = () => fleet.main.entries.map(({ entry }) => [entry.fields["status"], entry.body]);

test("the emitted worker contract distinguishes local recovery from unchanged and external blockers", async () => {
  h.onModel(() => ({ tool: "report", args: { status: "blocked", text: "Contract received" } }));
  h.onModel(() => ({ text: "Waiting for a task" }));
  await worker();
  const contract = (await h.waitForCall(0))
    .filter((turn) => turn.role === "system")
    .map((turn) => turn.text)
    .join("\n");
  assert.match(contract, /Fix errors confined to your copy/);
  assert.match(contract, /retry only with new evidence or a concrete correction/);
  assert.match(contract, /After two attempts with no progress, report `blocked`/);
  assert.match(
    contract,
    /Credentials, outside permissions or quota, destructive changes, and shared infrastructure are never local fixes/,
  );
  assert.deepEqual(reports(), [["blocked", "Contract received"]]);
});

test("a worker recovers from repeated exact-text misses by reading, correcting, and verifying", async () => {
  h.onModel(() => edit("label=stale", "label=correct"));
  h.onModel((turns) => {
    assert.match(result(turns), /Could not find/);
    return { tool: "read", args: { path: "label.txt" } };
  });
  h.onModel((turns) => {
    assert.match(result(turns), /label=original/);
    return edit("label=original\n", "label=intermediate\n");
  });
  h.onModel((turns) => {
    assert.match(result(turns), /Successfully replaced/);
    return edit("label=original\n", "label=correct\n");
  });
  h.onModel((turns) => {
    assert.match(result(turns), /Could not find/);
    return { tool: "read", args: { path: "label.txt" } };
  });
  h.onModel((turns) => {
    assert.match(result(turns), /label=intermediate/);
    return edit("label=intermediate\n", "label=correct\n");
  });
  h.onModel((turns) => {
    assert.match(result(turns), /Successfully replaced/);
    return { tool: "read", args: { path: "label.txt" } };
  });
  h.onModel((turns) => {
    assert.match(result(turns), /label=correct/);
    return { tool: "report", args: { status: "working", text: "Label corrected and verified" } };
  });
  h.onModel(() => ({
    tool: "report",
    args: { status: "blocked", text: "Implementation verified; delivery remains" },
  }));
  h.onModel(() => ({ text: "Waiting for delivery instructions" }));
  await worker();
  assert.equal(readFileSync(file, "utf8"), "label=correct\n");
  assert.deepEqual(reports(), [
    ["working", "Label corrected and verified"],
    ["blocked", "Implementation verified; delivery remains"],
  ]);
  assert.equal(h.calls.length, 10);
});

test("a worker reports the unchanged blocker after a repeated failure and leaves the file alone", async () => {
  h.onModel(() => edit("label=absent", "label=correct"));
  h.onModel((turns) => {
    assert.match(result(turns), /Could not find/);
    return edit("label=absent", "label=correct");
  });
  h.onModel((turns) => {
    assert.match(result(turns), /Could not find/);
    return {
      tool: "report",
      args: {
        status: "blocked",
        text: "Same match failure repeated without new evidence or correction",
      },
    };
  });
  h.onModel(() => ({ text: "Stopped" }));
  await worker();
  assert.equal(readFileSync(file, "utf8"), "label=original\n");
  assert.deepEqual(reports(), [
    ["blocked", "Same match failure repeated without new evidence or correction"],
  ]);
  assert.equal(h.calls.length, 4);
});

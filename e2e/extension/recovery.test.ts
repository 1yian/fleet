import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CardViewSchema, check, HttpOutcomeSchema, type Entry } from "@fleet/protocol";
import {
  lastUser,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workerGroupOf,
  workersOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import type { Harness, Turn } from "../support/harness.ts";

type Handler = Parameters<Harness["onModel"]>[0];

const STALE = "Cannot find module '/old/pi/dist/index.js' imported from /app/pi/loader.js";
const UNTIL = "2099-01-01T00:00:00Z";

let parts: DispatchLab;
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

const incidentIn = (turns: Turn[]): { incident: number; generation: number } => {
  const found = /Incident (\d+), process generation (\d+)/.exec(lastUser(turns) ?? "");
  return { incident: Number(found?.[1]), generation: Number(found?.[2]) };
};
const cardFor = (turns: Turn[]): number =>
  Number(
    /\[fleet\] \w+ on c-(\d)/.exec(turns.find((turn) => turn.role === "user")?.text ?? "")?.[1],
  );

function scriptMate(workers: number, react: Handler): void {
  const { h } = parts;
  for (let card = 1; card <= workers; card += 1)
    h.onModel(
      () => ({
        tool: "card_new",
        args: {
          title: `Task ${String(card)}`,
          name: `task-${String(card)}`,
          kind: "ship",
          project: "site",
        },
      }),
      "mate",
    );
  for (let card = 1; card <= workers; card += 1)
    h.onModel(
      () => ({ tool: "dispatch", args: { card, host: "local", task: "fix the scrollbar" } }),
      "mate",
    );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  for (let call = 0; call < 6; call += 1) h.onModel(react, "mate");
}

test("a worker with a stale module is replaced on its own conversation and work, verified by a real answer and action, with its neighbour untouched", async () => {
  parts = await startDispatchLab({ cardd: { CARDD_TIMING_SCALE: "0.02" } });
  const { h, lab, clone, mate } = parts;
  const tree = `${clone}.worktrees/c-1-a1`;
  let before: number | undefined;
  let beside: number | undefined;
  let failed = false;
  scriptMate(2, async (turns) => {
    if (turns.at(-1)?.role !== "user" || !(lastUser(turns) ?? "").includes("runtime failure"))
      return { text: "noted" };
    before = await workerGroupOf(lab, "c-1-a1");
    beside = await workerGroupOf(lab, "c-2-a1");
    return { tool: "recover", args: { ...incidentIn(turns), mode: "replace" } };
  });
  for (let call = 0; call < 12; call += 1)
    h.onModel((turns) => {
      const card = cardFor(turns);
      const last = turns.at(-1);
      if (card === 2)
        return last?.role === "toolResult"
          ? { text: "paused" }
          : { tool: "report", args: { status: "paused", text: "waiting", until: UNTIL } };
      if ((lastUser(turns) ?? "").includes("recovery check"))
        return last?.role === "toolResult"
          ? { text: "recovered" }
          : { tool: "report", args: { status: "note", text: "alive after replacement" } };
      if (failed) return { text: "took the task" };
      failed = true;
      writeFileSync(join(tree, "dirty.txt"), "uncommitted work\n");
      return { fail: STALE };
    }, "worker");
  await mateConnected(h);
  mate.prompt("ship both");

  const recovered = await waitFor(
    () => entriesOf(1),
    (view) => view.some((entry) => entry.body.includes("recovered (replace)")),
  );
  const entries = recovered;
  assert.equal(
    entries.filter((entry) => entry.fields["condition"] === "runtime-failure").length,
    2,
  );
  assert.match(
    entries.find((entry) => entry.body.includes("model turn failed"))?.body ?? "",
    /Classified stale-module\./,
  );
  const results = toolResults(await h.waitForCall(6, "mate", WORKER_WAIT_MS));
  assert.match(
    results.at(-1) ?? "",
    /^Started c-1-a1 again on local, on its own session and branch c-1-a1\. The recovery check reaches it/,
  );

  const after = await workerGroupOf(lab, "c-1-a1");
  assert.ok(
    before !== undefined && after !== undefined && after !== before,
    `process ${String(before)} -> ${String(after)}`,
  );
  assert.equal(await workerGroupOf(lab, "c-2-a1"), beside);
  assert.deepEqual(await workersOf(lab), ["c-1-a1", "c-2-a1"]);
  assert.equal(readFileSync(join(tree, "dirty.txt"), "utf8"), "uncommitted work\n");
  assert.equal(
    execFileSync("git", ["-C", tree, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    "c-1-a1",
  );
  const fresh = h.callsOf("worker").findLast((turns) => cardFor(turns) === 1) ?? [];
  assert.ok(
    fresh.some((turn) => turn.text.includes("fix the scrollbar")),
    "the old conversation is gone",
  );
  assert.match(
    lastUser(fresh) ?? "",
    /recovery check 1 from main: this is a health check, not new work/,
  );
  assert.equal(entries.filter((entry) => entry.fields["status"] === "note").length, 1);
  assert.ok(existsSync(tree));
});

test("a worker that cannot start is reported once, replaced once, and then blocked for the owner", async () => {
  parts = await startDispatchLab({
    cardd: { CARDD_TIMING_SCALE: "0.02" },
    workerArgs: ["--no-such-flag"],
  });
  const { h, mate, cardd, lab } = parts;
  scriptMate(1, (turns) =>
    turns.at(-1)?.role === "user" && (lastUser(turns) ?? "").includes("Recover with")
      ? { tool: "recover", args: { ...incidentIn(turns), mode: "replace" } }
      : { text: "noted" },
  );
  await mateConnected(h);
  mate.prompt("ship it");

  const view = await waitFor(
    () => entriesOf(1),
    (each) => each.some((entry) => entry.body.includes("needs intervention")),
    WORKER_WAIT_MS,
  );
  const told = view.filter((entry) => entry.fields["condition"] === "worker-never-connected");
  assert.equal(told.length, 1);
  assert.match(told[0]?.body ?? "", /^worker never connected\. Incident 1, process generation 0\./);
  assert.equal(view.filter((entry) => entry.body.includes("did not verify")).length, 1);
  assert.deepEqual(await workersOf(lab), []);
  const again = await cardd.post(parts.mainToken, "incident.recover", {
    incident: 1,
    generation: 0,
    mode: "replace",
    key: "later",
  });
  assert.equal(again.status, 400);
  assert.match(JSON.stringify(again.body), /is blocked/);
});

async function entriesOf(card: number): Promise<Entry[]> {
  const sent = await parts.cardd.post(parts.mainToken, "card", { card });
  const outcome = check(HttpOutcomeSchema, sent.body);
  if (!outcome.ok) throw new Error(outcome.error);
  return check(CardViewSchema, outcome.value).entries;
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  waitMs = WORKER_WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined && done(value)) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the record");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

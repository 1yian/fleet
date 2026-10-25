import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
import { gateOf } from "../support/hold-start.ts";
import { records } from "../support/json.ts";

type Handler = Parameters<Harness["onModel"]>[0];

const HOLD = fileURLToPath(new URL("../support/hold-start.ts", import.meta.url));
const STALE = "Cannot find module '/old/pi/dist/index.js' imported from /app/pi/loader.js";
const UNTIL = new Date(Date.now() + 3_600_000).toISOString();

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
    h.onModel(() => ({ tool: "board", args: {} }), "mate");
  for (let card = 1; card <= workers; card += 1)
    h.onModel(
      () => ({
        tool: "dispatch",
        args: {
          title: `Task ${String(card)}`,
          name: `task-${String(card)}`,
          kind: "ship",
          project: "site",
          intent: "Fix the scrollbar",
          host: "local",
          task: "fix the scrollbar",
        },
      }),
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
  let incident = { incident: 0, generation: 0 };
  let started: number | undefined;
  let repeated = false;
  const replace = (): { tool: string; args: Record<string, string | number> } => ({
    tool: "restart_card",
    args: { card: 1, ...incident, mode: "replace", key: "same" },
  });
  scriptMate(2, async (turns) => {
    if (turns.at(-1)?.role === "toolResult" && !repeated) {
      repeated = true;
      started = await readyWorkerGroup(lab, "c-1-a1");
      return replace();
    }
    if (turns.at(-1)?.role !== "user" || !(lastUser(turns) ?? "").includes("runtime failure"))
      return { text: "noted" };
    incident = incidentIn(turns);
    before = await readyWorkerGroup(lab, "c-1-a1");
    beside = await readyWorkerGroup(lab, "c-2-a1");
    return replace();
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
  const named = async (): Promise<[number, string][]> => boardNames();

  const recovered = await waitFor(
    () => entriesOf(1),
    (view) => view.some((entry) => entry.body.includes("recovered (replace)")),
  );
  await verifyDuplicate(incident);
  const entries = recovered;
  assert.equal(
    entries.filter((entry) => entry.fields["condition"] === "runtime-failure").length,
    2,
  );
  assert.match(
    entries.find((entry) => entry.body.includes("model turn failed"))?.body ?? "",
    /Classified stale-module\./,
  );
  const results = await mateResults(h, 6);
  assert.match(
    results.at(-2) ?? "",
    /^Started c-1-a1 again on local, on its own session and branch c-1-a1\. The recovery check reaches it/,
  );
  assert.match(results.at(-1) ?? "", /already runs a new process|left it alone|already runs on/);

  const after = await workerGroupOf(lab, "c-1-a1");
  assert.ok(
    before !== undefined && after !== undefined && after !== before,
    `process ${String(before)} -> ${String(after)}`,
  );
  assert.equal(after, started);
  assert.equal(await workerGroupOf(lab, "c-2-a1"), beside);
  assert.deepEqual(await workersOf(lab), ["c-1-a1", "c-2-a1"]);
  assert.deepEqual(await named(), [
    [1, "task-1"],
    [2, "task-2"],
  ]);
  assert.equal(readFileSync(join(tree, "dirty.txt"), "utf8"), "uncommitted work\n");
  assert.equal(branchOfTree(tree), "c-1-a1");
  const fresh = h.callsOf("worker").findLast((turns) => cardFor(turns) === 1) ?? [];
  assert.ok(
    fresh.some((turn) => turn.text.includes("fix the scrollbar")),
    "the old conversation is gone",
  );
  assert.match(
    lastUser(fresh) ?? "",
    new RegExp(
      `recovery check ${String(incident.incident)} from main: this is a health check, not new work`,
    ),
  );
  assert.equal(entries.filter((entry) => entry.fields["status"] === "note").length, 1);
  assert.ok(existsSync(tree));
});

async function readyWorkerGroup(lab: DispatchLab["lab"], attempt: string): Promise<number> {
  const group = await waitFor(
    () => workerGroupOf(lab, attempt),
    (value) => value !== undefined,
    WORKER_WAIT_MS,
  );
  if (group === undefined) throw new Error(`${attempt} has no process group`);
  return group;
}

function branchOfTree(tree: string): string {
  return execFileSync("git", ["-C", tree, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

async function verifyDuplicate(incident: { incident: number; generation: number }): Promise<void> {
  const duplicate = await parts.cardd.post(parts.mainToken, "card.restart", {
    card: 1,
    ...incident,
    mode: "replace",
    key: "same",
  });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.body, {
    ok: true,
    value: {
      incident: incident.incident,
      mode: "replace",
      actor: "c-1-a1",
      role: "worker",
      lane: "main",
      host: "local",
      card: 1,
      generation: incident.generation,
      replaced: true,
      repeat: true,
    },
  });
}

function mateResults(h: Harness, count: number): Promise<string[]> {
  return waitFor(
    () => Promise.resolve(toolResults(h.callsOf("mate").at(-1) ?? [])),
    (each) => each.length >= count,
    WORKER_WAIT_MS,
  );
}

test("a worker that cannot start is reported once, replaced once, and then blocked for the owner", async () => {
  parts = await startDispatchLab({
    cardd: { CARDD_TIMING_SCALE: "0.02" },
    workerArgs: ["--no-such-flag"],
  });
  const { h, mate, cardd, lab } = parts;
  scriptMate(1, (turns) =>
    turns.at(-1)?.role === "user" && (lastUser(turns) ?? "").includes("Recover with")
      ? { tool: "restart_card", args: { card: 1, ...incidentIn(turns), mode: "replace" } }
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
  assert.ok(told.length >= 1);
  assert.match(told[0]?.body ?? "", /^worker never connected\. Incident 1, process generation 0\./);
  assert.equal(view.filter((entry) => entry.body.includes("did not verify")).length, 1);
  assert.deepEqual(await workersOf(lab), []);
  const again = await cardd.post(parts.mainToken, "card.restart", {
    card: 1,
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

test("a stale compactor import is replaced on the same card and conversation, and only a successful compaction verifies it", async () => {
  parts = await startDispatchLab({ cardd: { CARDD_TIMING_SCALE: "0.02" } });
  const { h, lab, clone, mate } = parts;
  const tree = `${clone}.worktrees/c-1-a1`;
  let compactorUp = false;
  let before: number | undefined;
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Task 1",
        name: "task-1",
        kind: "ship",
        project: "site",
        intent: "Fix the scrollbar",
        host: "local",
        task: `fix the scrollbar ${"lorem ipsum dolor ".repeat(9000)}`,
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  for (let call = 0; call < 6; call += 1)
    h.onModel(async (turns) => {
      if (turns.at(-1)?.role !== "user" || !(lastUser(turns) ?? "").includes("runtime failure"))
        return { text: "noted" };
      before = await readyWorkerGroup(lab, "c-1-a1");
      compactorUp = true;
      return { tool: "restart_card", args: { card: 1, ...incidentIn(turns), mode: "replace" } };
    }, "mate");
  scriptCompactingWorker(tree, () => compactorUp);
  await mateConnected(h);
  mate.prompt("ship it");
  await h.waitForCall(1, "worker", WORKER_WAIT_MS);
  const pane = await paneOf(lab, "c-1-a1");
  const cardsBefore = await boardNames();
  await lab.run(["pane", "send-text", pane, "/compact"]);
  await lab.run(["pane", "send-keys", pane, "enter"]);

  const entries = await waitFor(
    () => entriesOf(1),
    (view) => view.some((entry) => entry.body.includes("recovered (replace)")),
  );
  const failure = entries.find((entry) => entry.body.includes("compaction failed"));
  assert.match(failure?.body ?? "", /Classified stale-module\./);
  assert.match(failure?.body ?? "", /mode=replace\)\.$/);
  assert.match(
    entries.find((entry) => entry.body.includes("recovered (replace)"))?.body ?? "",
    /compacted its conversation successfully/,
  );
  const after = await workerGroupOf(lab, "c-1-a1");
  assert.ok(before !== undefined && after !== undefined && after !== before);
  assert.deepEqual(await boardNames(), cardsBefore);
  assert.deepEqual(await workersOf(lab), ["c-1-a1"]);
  assert.equal(readFileSync(join(tree, "dirty.txt"), "utf8"), "uncommitted work\n");
  assert.equal(
    entries.filter((entry) => entry.fields["condition"] === "runtime-failure").length,
    2,
  );
});

function scriptCompactingWorker(tree: string, compactorUp: () => boolean): void {
  const { h } = parts;
  for (let call = 0; call < 12; call += 1)
    h.onModel((turns) => {
      if (turns.some((turn) => turn.text.includes("ONLY output the structured summary")))
        return compactorUp() ? { text: "a summary" } : { fail: STALE };
      if (turns.at(-1)?.role === "toolResult")
        return { text: `waiting on the job ${"lorem ipsum dolor ".repeat(9000)}` };
      writeFileSync(join(tree, "dirty.txt"), "uncommitted work\n");
      return { tool: "run_long", args: { label: "wait", command: "sleep 600" } };
    }, "worker");
}

async function paneOf(lab: DispatchLab["lab"], attempt: string): Promise<string> {
  const panes = records((await lab.run(["pane", "list"]))["panes"]);
  const found = panes.find((pane) => String(pane["cwd"]).endsWith(`.worktrees/${attempt}`));
  return String(found?.["pane_id"]);
}

async function boardNames(): Promise<[number, string][]> {
  return (await parts.cardd.board()).cards.map((each) => [each.id, each.name]);
}

test("a replacement requested again with the same key while it is still starting leaves the starting process alone", async () => {
  parts = await startDispatchLab({
    cardd: { CARDD_TIMING_SCALE: "0.02" },
    workerArgs: ["-e", HOLD],
  });
  const { h, lab, clone, mate, cardd } = parts;
  const tree = `${clone}.worktrees/c-1-a1`;
  const gate = gateOf(join(h.dir, "worker-args"));
  let failed = false;
  let incident = { incident: 0, generation: 0 };
  let starting: number | undefined;
  let phase: "first" | "again" | "done" = "first";
  const replace = (): { tool: string; args: Record<string, string | number> } => ({
    tool: "restart_card",
    args: { card: 1, ...incident, mode: "replace", key: "same" },
  });
  scriptMate(1, async (turns) => {
    if (phase === "first") {
      if (turns.at(-1)?.role !== "user" || !lastUser(turns)?.includes("runtime failure"))
        return { text: "noted" };
      incident = incidentIn(turns);
      execFileSync("sh", ["-c", 'mkfifo "$0"', gate]);
      phase = "again";
      return replace();
    }
    if (phase === "again") {
      phase = "done";
      starting = await readyWorkerGroup(lab, "c-1-a1");
      return replace();
    }
    return { text: "noted" };
  });
  for (let call = 0; call < 12; call += 1)
    h.onModel((turns) => {
      if ((lastUser(turns) ?? "").includes("recovery check"))
        return turns.at(-1)?.role === "toolResult"
          ? { text: "recovered" }
          : { tool: "report", args: { status: "note", text: "alive after replacement" } };
      if (failed) return { text: "took the task" };
      failed = true;
      writeFileSync(join(tree, "dirty.txt"), "uncommitted work\n");
      return { fail: STALE };
    }, "worker");
  await mateConnected(h);
  mate.prompt("ship it");

  const results = await mateResults(h, 4);
  assert.match(results.at(-2) ?? "", /^Started c-1-a1 again on local/);
  assert.match(
    results.at(-1) ?? "",
    /already runs or is starting on local, so this repeated request left it alone/,
  );
  const sessions = (await cardd.post(parts.mainToken, "card", { card: 1 })).status;
  assert.equal(sessions, 200);
  assert.equal(await workerGroupOf(lab, "c-1-a1"), starting);
  const release = await open(gate, "w");
  await release.close();
  await waitFor(
    () => entriesOf(1),
    (view) => view.some((entry) => entry.body.includes("recovered (replace)")),
    WORKER_WAIT_MS,
  );

  assert.equal(await workerGroupOf(lab, "c-1-a1"), starting);
  assert.deepEqual(await workersOf(lab), ["c-1-a1"]);
  assert.deepEqual(await boardNames(), [[1, "task-1"]]);
  assert.equal(readFileSync(join(tree, "dirty.txt"), "utf8"), "uncommitted work\n");
  const view = await entriesOf(1);
  assert.equal(view.filter((entry) => entry.body.includes("recovered (replace)")).length, 1);
  assert.equal(view.filter((entry) => entry.fields["status"] === "note").length, 1);
});

test("a stale import on the nudge turn is one incident, replaced on the same card and conversation, with no stopped report", async () => {
  parts = await startDispatchLab({ cardd: { CARDD_TIMING_SCALE: "0.02" } });
  const { h, mate } = parts;
  const nudge =
    "Cannot find module '/pi/dist/bundle/chunks/openai-completions-X.js' imported from /pi/dist/bundle/chunk-Y.js";
  let ran = 0;
  scriptMate(1, (turns) =>
    turns.at(-1)?.role === "user" && (lastUser(turns) ?? "").includes("Classified stale-module")
      ? {
          tool: "restart_card",
          args: { card: 1, ...incidentIn(turns), mode: "replace", key: "same" },
        }
      : { text: "noted" },
  );
  for (let call = 0; call < 8; call += 1)
    h.onModel((turns) => {
      if ((lastUser(turns) ?? "").includes("recovery check"))
        return turns.at(-1)?.role === "toolResult"
          ? { text: "recovered" }
          : { tool: "report", args: { status: "note", text: "alive after replacement" } };
      ran += 1;
      return ran === 1 ? { text: "I think I am done" } : { fail: nudge };
    }, "worker");
  await mateConnected(h);
  mate.prompt("ship it");

  const entries = await waitFor(
    () => entriesOf(1),
    (view) => view.some((entry) => entry.body.includes("recovered (replace)")),
  );
  const failures = entries.filter((entry) => entry.fields["condition"] === "runtime-failure");
  assert.equal(failures.filter((entry) => entry.body.startsWith("runtime failure")).length, 1);
  assert.match(
    failures[0]?.body ?? "",
    /Classified stale-module\. Incident \d+, process generation 1\./,
  );
  assert.deepEqual(
    entries.filter((entry) => entry.fields["status"] === "stopped"),
    [],
  );
  const fresh =
    h.callsOf("worker").findLast((turns) => (lastUser(turns) ?? "").includes("recovery check")) ??
    [];
  assert.ok(
    fresh.some((turn) => turn.text.includes("fix the scrollbar")),
    "the old conversation is gone",
  );
});

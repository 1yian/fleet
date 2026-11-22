import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { lastUser, toolResults, WORKER_WAIT_MS, workersOf } from "../support/dispatch-lab.ts";
import type { Turn } from "../support/harness.ts";
import {
  alive,
  cardd,
  dispatchOperation,
  finished,
  h,
  hostScratch,
  lab,
  originCalls,
  report,
  scratch,
  start,
  reportFromWorker,
  tree,
  written,
  workerWrites,
} from "../support/operation-lab.ts";
import { git, tip } from "../support/remote.ts";

test("ops dispatches offline with a no-PR contract and hands evidence over without opening a path", async () => {
  dispatchOperation();
  const before = tip(scratch.root);
  const seen: string[] = [];
  h.onModel(async (turns) => {
    assert.match(lastUser(turns) ?? "", /Delivery: ops$/);
    const contract = turns.find((turn) => turn.role === "system")?.text ?? "";
    assert.match(contract, /## Delivery: ops/);
    assert.match(contract, /No PR, commit, push, or merge is expected/);
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    return workerWrites();
  }, "worker");
  h.onModel((turns) => reportFromWorker(turns), "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel((turns) => {
    assert.match(lastUser(turns) ?? "", /operation: no PR expected/i);
    assert.doesNotMatch(lastUser(turns) ?? "", /no PR URL reported/);
    return { tool: "board", args: { card: 1 } };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { text: "left open" };
  }, "mate");
  await start();
  await finished(4);
  const [board = ""] = seen;
  assert.match(board, /delivery: ops/);
  assert.match(board, /^\s*evidence: "?reported, shape-checked only and not verified/m);
  assert.doesNotMatch(board, /^\s*report: |operation\.md/m);
  const web = JSON.stringify(await cardd.thread(1));
  assert.doesNotMatch(web, /scratch|operation\.md/);
  assert.equal(originCalls(), "");
  assert.equal(tip(scratch.root), before);
  assert.equal(git(scratch.root, "for-each-ref", "refs/remotes"), "");
  assert.equal((await cardd.thread(1)).card.status, "with-mate");
  assert.equal(existsSync(tree), true);
  assert.match(readFileSync(report, "utf8"), /Observed state: ready/);
  assert.equal((await workersOf(lab)).length, 1);
  assert.match(cardd.admin("project", "list").stdout, /fleet: no-mistakes/);
  const forbidden = cardd.admin("project", "delivery", "fleet", "ops");
  assert.notEqual(forbidden.status, 0);
  assert.match(forbidden.stderr, /ops is card-only/);
});

test("ops accepts evidence only on its done handoff, inside its card scratch folder, with no PR or merge claim", async () => {
  dispatchOperation();
  const refusal = (turns: Turn[], expected: RegExp): void => {
    assert.match(toolResults(turns).at(-1) ?? "", expected);
  };
  const outside = join(scratch.parent, "evidence", "operation.md");
  const scoped = /ops evidence must be a file in this card's \$FLEET_SCRATCH folder/;
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    return { tool: "report", args: { status: "done", text: "finished" } };
  }, "worker");
  h.onModel((turns) => {
    refusal(turns, /ops completion requires evidence/);
    return { tool: "report", args: { status: "working", text: "going", evidence: report } };
  }, "worker");
  h.onModel((turns) => {
    refusal(turns, /evidence is only for the done report of an ops card/);
    return { tool: "report", args: written(outside).args };
  }, "worker");
  h.onModel((turns) => {
    refusal(turns, scoped);
    return {
      tool: "report",
      args: written(join(hostScratch(), "c-1", "tmp", "operation.md")).args,
    };
  }, "worker");
  h.onModel((turns) => {
    refusal(turns, scoped);
    const claim = { pr: "https://github.com/acme/fleet/pull/8", merged: true };
    return { tool: "report", args: { ...written(report).args, ...claim } };
  }, "worker");
  h.onModel((turns) => {
    refusal(turns, /ops work does not report a PR or merge/);
    return { tool: "report", args: { ...written(report).args, status: "merged" } };
  }, "worker");
  h.onModel((turns) => {
    refusal(turns, /ops work does not report a PR or merge/);
    return workerWrites();
  }, "worker");
  h.onModel((turns) => reportFromWorker(turns), "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ text: "left open" }), "mate");
  await start();
  await finished(3);
  const thread = await cardd.thread(1);
  assert.equal(thread.card.pr, null);
  assert.equal(
    thread.entries.filter((entry) => entry.kind === "report" && entry.fields["status"] === "done")
      .length,
    1,
  );
});

test("a steer after done cancels the handoff on the board", async () => {
  dispatchOperation();
  const seen: string[] = [];
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    return workerWrites();
  }, "worker");
  h.onModel((turns) => reportFromWorker(turns), "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ text: "noted" }), "worker");
  h.onModel(() => ({ tool: "board", args: { card: 1 } }), "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { tool: "comment", args: { card: 1, text: "Check one more thing first." } };
  }, "mate");
  h.onModel(() => ({ tool: "board", args: { card: 1 } }), "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { text: "done" };
  }, "mate");
  await start();
  await finished(7);
  assert.match(seen[0] ?? "", /^\s*evidence: "?reported, shape-checked only and not verified/m);
  assert.doesNotMatch(seen[1] ?? "", /evidence: /);
});

test("close refuses an ops card that has no done report and leaves its worker running, then ends it Done once the evidence is handed over", async () => {
  dispatchOperation({ tool: "close", args: { card: 1, summary: "Operation done" } });
  const pidFile = join(h.dir, "worker.pid");
  const refused = Promise.withResolvers<{
    answer: string;
    workers: string[];
    tree: boolean;
    status: string;
    cleanups: number;
  }>();
  h.onModel(async () => {
    await refused.promise;
    return {
      tool: "bash",
      args: { command: `echo $PPID > "${pidFile}"; ${workerWrites().args.command}` },
    };
  }, "worker");
  h.onModel((turns) => reportFromWorker(turns), "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(async (turns) => {
    const thread = await cardd.thread(1);
    refused.resolve({
      answer: toolResults(turns).at(-1) ?? "",
      workers: await workersOf(lab),
      tree: existsSync(tree),
      status: thread.card.status,
      cleanups: thread.entries.filter((entry) => entry.kind === "cleanup").length,
    });
    return { text: "left open" };
  }, "mate");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Operation done" } }), "mate");
  h.onModel(() => ({ text: "closed" }), "mate");
  await start();
  const closing = await finished(5);
  const first = await refused.promise;
  assert.match(first.answer, /c-1 did not land: the worker has not reported done\./);
  assert.deepEqual(first.workers, ["c-1-a1"]);
  assert.equal(first.tree, true);
  assert.equal(first.status, "working");
  assert.equal(first.cleanups, 0);

  assert.match(toolResults(closing).at(-1) ?? "", /^c-1 is done\./);
  assert.equal(alive(Number(readFileSync(pidFile, "utf8").trim())), false);
  const thread = await cardd.thread(1);
  assert.equal(thread.card.status, "done");
  assert.deepEqual(
    thread.entries
      .filter((entry) => entry.kind === "cleanup")
      .map((entry) => entry.fields["outcome"]),
    ["done"],
  );
  assert.equal(existsSync(tree), false);
  assert.deepEqual(await workersOf(lab), []);
  assert.equal(git(scratch.root, "branch", "--list", "c-1-a1"), "");
  assert.equal(existsSync(`${scratch.root}.archive`), false);
  assert.match(readFileSync(report, "utf8"), /Observed state: ready/);
  assert.equal(originCalls(), "");
});

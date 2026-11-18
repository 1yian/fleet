import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { lastUser, toolResults, WORKER_WAIT_MS, workersOf } from "../support/dispatch-lab.ts";
import type { Turn } from "../support/harness.ts";
import {
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
  tree,
  written,
} from "../support/operation-lab.ts";
import { git, tip } from "../support/remote.ts";

test("ops dispatches offline with a no-PR contract and hands evidence over without opening a path", async () => {
  dispatchOperation();
  const before = tip(scratch.root);
  const seen: string[] = [];
  h.onModel(async (turns) => {
    assert.match(lastUser(turns) ?? "", /Delivery: ops$/);
    const contract = turns.find((turn) => turn.role === "system")?.text ?? "";
    assert.match(contract, /### Delivery: ops/);
    assert.match(contract, /No PR, commit, push, or merge is expected/);
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    return written(report);
  }, "worker");
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
  assert.match(board, /^\s*evidence: "?reported, not verified: do not read it/m);
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
    return written(report);
  }, "worker");
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
    return written(report);
  }, "worker");
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
  await finished(5);
  assert.match(seen[0] ?? "", /^\s*evidence: "?reported, not verified/m);
  assert.doesNotMatch(seen[1] ?? "", /evidence: /);
});

test("closing an ops card is refused in every mode and changes nothing", async () => {
  dispatchOperation();
  const refused: string[] = [];
  const before: { head: string; branches: string } = { head: "", branches: "" };
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    writeFileSync(join(tree, ".gitignore"), "ignored/\n");
    git(tree, "add", ".gitignore");
    writeFileSync(join(tree, "product.txt"), "unexpected product change\n");
    git(tree, "add", "product.txt");
    git(tree, "commit", "-qm", "unexpected product change");
    writeFileSync(join(tree, "untracked.txt"), "preserve me\n");
    mkdirSync(join(tree, "ignored"));
    writeFileSync(join(tree, "ignored", "leak.txt"), "ignored but mine\n");
    before.head = git(tree, "rev-parse", "HEAD");
    before.branches = git(scratch.root, "branch", "--list");
    return written(report);
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  const attempts = [
    { card: 1, summary: "Done" },
    { card: 1, summary: "Done", confirm: true },
    { card: 1, summary: "Not approved", landed: false },
    { card: 1, summary: "Not approved", landed: false, confirm: true },
  ];
  attempts.forEach((args, index) => {
    h.onModel((turns) => {
      if (index > 0) refused.push(toolResults(turns).at(-1) ?? "");
      return { tool: "close", args };
    }, "mate");
  });
  h.onModel((turns) => {
    refused.push(toolResults(turns).at(-1) ?? "");
    return { text: "left open" };
  }, "mate");
  await start();
  await finished(7);
  const answers = refused;
  assert.equal(answers.length, 4);
  for (const answer of answers)
    assert.match(
      answer,
      /c-1 delivers ops; closing an operation is not available until authoritative retirement lands \(tracked on its own card\); leave it open/,
    );
  const thread = await cardd.thread(1);
  assert.equal(thread.card.status, "with-mate");
  assert.equal(
    thread.entries.some((entry) => entry.kind === "cleanup"),
    false,
  );
  assert.equal(git(tree, "rev-parse", "HEAD"), before.head);
  assert.equal(git(scratch.root, "branch", "--list"), before.branches);
  assert.equal(readFileSync(join(tree, "untracked.txt"), "utf8"), "preserve me\n");
  assert.equal(readFileSync(join(tree, "ignored", "leak.txt"), "utf8"), "ignored but mine\n");
  assert.equal(existsSync(`${scratch.root}.archive`), false);
  assert.equal(existsSync(join(hostScratch(), "c-1", "operation.md")), true);
  assert.equal((await workersOf(lab)).length, 1);
});

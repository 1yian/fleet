import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  branchesOf,
  lastUser,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  worktreesOf,
} from "../support/dispatch-lab.ts";
import {
  alive,
  cardd,
  closedFolders,
  dispatchOperation,
  finished,
  h,
  hostScratch,
  lab,
  originCalls,
  report,
  scratch,
  start,
  startWriter,
  tree,
  written,
} from "../support/operation-lab.ts";
import type { Turn } from "../support/harness.ts";
import { git, tip } from "../support/remote.ts";

test("ops runs offline, hands evidence over in its own field, closes clean, and keeps the report after close", async () => {
  dispatchOperation();
  const refs = git(scratch.root, "for-each-ref");
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
    assert.match(lastUser(turns) ?? "", /operation complete.*no PR expected/i);
    assert.doesNotMatch(lastUser(turns) ?? "", /no PR URL reported/);
    return { tool: "board", args: { card: 1 } };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { tool: "close", args: { card: 1, summary: `Operation verified: ${report}` } };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { tool: "board", args: { card: 1 } };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { text: "closed" };
  }, "mate");
  await start();
  await finished(6);
  const [open, closed, after] = seen;
  assert.match(open ?? "", /delivery: ops/);
  assert.match(open ?? "", /^\s*evidence: "?reported; close verifies/m);
  assert.doesNotMatch(open ?? "", /^\s*report: |operation\.md/m);
  const retained = closedFolders();
  assert.equal(retained.length, 1);
  const exact = join(hostScratch(), retained[0] ?? "", "operation.md");
  assert.equal(closed, `c-1 is done. Evidence kept at local:${exact}.`);
  assert.doesNotMatch(after ?? "", /retained|operation\.md|scratch/);
  const web = JSON.stringify(await cardd.thread(1));
  assert.doesNotMatch(web, /scratch|operationReceipt|operation\.md/);
  assert.equal(originCalls(), "");
  assert.match(
    readFileSync(join(hostScratch(), retained[0] ?? "", "operation.md"), "utf8"),
    /Observed state: ready/,
  );
  assert.equal(existsSync(join(hostScratch(), "c-1")), false);
  assert.equal((await cardd.thread(1)).card.status, "done");
  assert.equal(tip(scratch.root), before);
  assert.equal(git(scratch.root, "for-each-ref"), refs);
  assert.deepEqual(worktreesOf(scratch.root), ["branch refs/heads/main"]);
  assert.deepEqual(branchesOf(scratch.root), ["main"]);
  assert.deepEqual(await workersOf(lab), []);
  assert.match(cardd.admin("project", "list").stdout, /fleet: no-mistakes/);
  const forbidden = cardd.admin("project", "delivery", "fleet", "ops");
  assert.notEqual(forbidden.status, 0);
  assert.match(forbidden.stderr, /ops is card-only/);
});

test("ops refuses a done handoff without evidence, with evidence outside its card scratch folder, on other statuses, or with PR or merge claims", async () => {
  dispatchOperation();
  const refusal = (turns: Turn[], expected: RegExp): void => {
    assert.match(toolResults(turns).at(-1) ?? "", expected);
  };
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
    return { tool: "report", args: written(join(scratch.parent, "evidence", "operation.md")).args };
  }, "worker");
  h.onModel((turns) => {
    refusal(turns, /ops evidence must be a file in this card's \$FLEET_SCRATCH folder/);
    return {
      tool: "report",
      args: written(join(hostScratch(), "c-1", "tmp", "operation.md")).args,
    };
  }, "worker");
  h.onModel((turns) => {
    refusal(turns, /ops evidence must be a file in this card's \$FLEET_SCRATCH folder/);
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
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Verified" } }), "mate");
  h.onModel(() => ({ text: "closed" }), "mate");
  await start();
  const turns = await finished(4);
  assert.match(toolResults(turns).at(-1) ?? "", /^c-1 is done\. Evidence kept at local:/);
  const thread = await cardd.thread(1);
  assert.equal(thread.card.pr, null);
  assert.equal(
    thread.entries.filter((entry) => entry.kind === "report" && entry.fields["status"] === "done")
      .length,
    1,
  );
});

const UNREADABLE = [
  {
    name: "in the scratch folder of another host root",
    remove: false,
    link: false,
    place: (): string => join(scratch.parent, "scratch", "c-1", "operation.md"),
  },
  {
    name: "a symlink to a private file outside the scratch folder",
    remove: false,
    link: true,
    place: (): string => report,
  },
  {
    name: "gone before close",
    remove: true,
    link: false,
    place: (): string => report,
  },
];

for (const { name, place, remove, link } of UNREADABLE) {
  test(`ops refuses Done, removes nothing, and names no path when the evidence is ${name}`, async () => {
    dispatchOperation();
    const seen: string[] = [];
    h.onModel(async () => {
      await h.waitForCall(2, "mate", WORKER_WAIT_MS);
      if (!link) return written(place());
      const secret = join(scratch.parent, "private.md");
      writeFileSync(secret, "private lane record\n");
      mkdirSync(join(hostScratch(), "c-1"), { recursive: true });
      symlinkSync(secret, report);
      return {
        tool: "report",
        args: { status: "done", text: "Operation complete", evidence: report },
      };
    }, "worker");
    h.onModel(() => ({ text: "reported" }), "worker");
    h.onModel(() => ({ tool: "board", args: { card: 1 } }), "mate");
    h.onModel((turns) => {
      seen.push(toolResults(turns).at(-1) ?? "");
      if (remove) unlinkSync(place());
      return { tool: "close", args: { card: 1, summary: "Operation complete", confirm: true } };
    }, "mate");
    h.onModel(() => ({ text: "close attempted" }), "mate");
    await start();
    const refused = toolResults(await finished(5)).at(-1) ?? "";
    const [board = ""] = seen;
    assert.match(board, /^\s*evidence: "?reported; close verifies/m);
    assert.doesNotMatch(board, /^\s*report: |operation\.md|private/m);
    assert.match(refused, /cannot close Done: its ops evidence is not a regular report file/);
    assert.doesNotMatch(refused, /operation\.md|private|failed|ENOENT/);
    assert.equal((await cardd.thread(1)).card.status, "with-mate");
    assert.equal(existsSync(tree), true);
    assert.equal(existsSync(`${scratch.root}.archive`), false);
  });
}

test("ops refuses Done when a writer removes the evidence while close stops it", async () => {
  dispatchOperation();
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    return startWriter(`rm -f ${report}`);
  }, "worker");
  h.onModel(() => written(report), "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Operation complete" } }), "mate");
  h.onModel(() => ({ text: "close attempted" }), "mate");
  await start();
  const refused = toolResults(await finished(4)).at(-1) ?? "";
  assert.match(refused, /cannot close Done: its ops evidence is not a regular report file/);
  assert.equal(alive(Number(readFileSync(join(h.dir, "writer.pid"), "utf8").trim())), false);
  assert.equal(existsSync(report), false);
  assert.equal((await cardd.thread(1)).card.status, "with-mate");
  assert.equal(existsSync(tree), true);
});

test("a steer after done cancels the handoff for the board and for close alike", async () => {
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
    return { tool: "close", args: { card: 1, summary: "Operation complete" } };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { text: "close attempted" };
  }, "mate");
  await start();
  await finished(7);
  const [before, after, refused] = seen;
  assert.match(before ?? "", /^\s*evidence: "?reported; close verifies/m);
  assert.doesNotMatch(after ?? "", /evidence: /);
  assert.match(refused ?? "", /the worker has not reported done/);
  assert.notEqual((await cardd.thread(1)).card.status, "done");
  assert.equal(existsSync(tree), true);
});

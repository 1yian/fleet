import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { toolResults, WORKER_WAIT_MS } from "../support/dispatch-lab.ts";
import {
  alive,
  archivedUntracked,
  cardd,
  closedFolders,
  dispatchOperation,
  finished,
  h,
  hostScratch,
  report,
  scratch,
  start,
  startWriter,
  tree,
  written,
} from "../support/operation-lab.ts";
import { git, tip } from "../support/remote.ts";

test("ops refuses Done for unexpected commits and files even with confirm, and preserves them until an explicit drop", async () => {
  dispatchOperation();
  const before = tip(scratch.root);
  const seen: string[] = [];
  let unexpected = "";
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    writeFileSync(join(tree, "product.txt"), "unexpected product change\n");
    git(tree, "add", "product.txt");
    git(tree, "commit", "-qm", "unexpected product change");
    unexpected = git(tree, "rev-parse", "HEAD").trim();
    writeFileSync(join(tree, "untracked.txt"), "preserve me\n");
    return written(report);
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Operation complete" } }), "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { tool: "close", args: { card: 1, summary: "Operation complete", confirm: true } };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return {
      tool: "close",
      args: {
        card: 1,
        summary: "Unexpected changes are not approved; preserve them",
        landed: false,
      },
    };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { text: "dropped" };
  }, "mate");
  await start();
  await finished(6);
  const [plain, confirmed, dropped] = seen;
  for (const refusal of [plain ?? "", confirmed ?? ""]) {
    assert.match(
      refusal,
      /1 commit not on main and 1 changed, untracked or ignored file, left in place/,
    );
    assert.match(refusal, /product change/);
    assert.match(refusal, /untracked\.txt/);
    assert.match(refusal, /cannot end Done with unexpected code changes, even with confirm=true/);
  }
  const archive = `${scratch.root}.archive/c-1-a1.tar.zst`;
  assert.equal(dropped, `c-1 is dropped. Unlanded work is archived in local:${archive}.`);
  const packed = execFileSync("zstd", ["-dc", archive]);
  const bundle = join(scratch.parent, "preserved.bundle");
  writeFileSync(
    bundle,
    execFileSync("tar", ["-xOf", "-", "c-1-a1/commits.bundle"], { input: packed }),
  );
  const restored = join(scratch.parent, "restored");
  git(scratch.parent, "clone", "-q", scratch.root, restored);
  git(restored, "fetch", "-q", bundle, "HEAD:refs/heads/unexpected");
  assert.equal(git(restored, "rev-parse", "unexpected"), unexpected);
  assert.equal(git(restored, "show", "unexpected:product.txt"), "unexpected product change");
  assert.equal(archivedUntracked(archive, "untracked.txt"), "preserve me\n");
  assert.equal(tip(scratch.root), before);
  const kept = closedFolders();
  assert.match(
    readFileSync(join(hostScratch(), kept[0] ?? "", "operation.md"), "utf8"),
    /Observed/,
  );
});

test("ops refuses Done for a writer that is still running when close stops it, and preserves what it wrote", async () => {
  dispatchOperation();
  const seen: string[] = [];
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    return startWriter("echo late > late.txt");
  }, "worker");
  h.onModel(() => written(report), "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Operation complete" } }), "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { tool: "close", args: { card: 1, summary: "Not approved", landed: false } };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { text: "dropped" };
  }, "mate");
  await start();
  await finished(5);
  const [refused, dropped] = seen;
  assert.match(
    refused ?? "",
    /c-1 was not closed\. c-1-a1 on local has 1 changed, untracked or ignored file/,
  );
  assert.match(refused ?? "", /late\.txt/);
  assert.match(dropped ?? "", /^c-1 is dropped\. .*Unlanded work is archived in local:/);
  const pid = Number(readFileSync(join(h.dir, "writer.pid"), "utf8").trim());
  assert.equal(alive(pid), false);
  assert.equal(archivedUntracked(`${scratch.root}.archive/c-1-a1.tar.zst`, "late.txt"), "late\n");
  assert.equal((await cardd.thread(1)).card.status, "dropped");
});

test("ops refuses Done for a commit left on its task branch while the worktree is back on a clean base", async () => {
  dispatchOperation();
  const seen: string[] = [];
  let left = "";
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    writeFileSync(join(tree, "kept.txt"), "left on the branch\n");
    git(tree, "add", "kept.txt");
    git(tree, "commit", "-qm", "left on the branch");
    left = git(tree, "rev-parse", "HEAD");
    git(tree, "checkout", "-q", "--detach", "main");
    return written(report);
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Operation complete" } }), "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { text: "close attempted" };
  }, "mate");
  await start();
  await finished(4);
  assert.match(seen[0] ?? "", /1 commit not on main, left in place/);
  assert.match(seen[0] ?? "", /left on the branch/);
  assert.equal(git(scratch.root, "rev-parse", "refs/heads/c-1-a1"), left);
  assert.equal(existsSync(tree), true);
  assert.equal((await cardd.thread(1)).card.status, "with-mate");
});

test("ops refuses Done for an ignored file in the worktree, which removal would delete", async () => {
  dispatchOperation();
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    mkdirSync(join(tree, "state"), { recursive: true });
    writeFileSync(join(tree, "state", "leak.txt"), "ignored but not mine\n");
    return written(report);
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Operation complete" } }), "mate");
  h.onModel(() => ({ text: "close attempted" }), "mate");
  await start();
  const refused = toolResults(await finished(4)).at(-1) ?? "";
  assert.match(refused, /1 changed, untracked or ignored file, left in place/);
  assert.match(refused, /state\/leak\.txt/);
  assert.equal(readFileSync(join(tree, "state", "leak.txt"), "utf8"), "ignored but not mine\n");
  assert.equal((await cardd.thread(1)).card.status, "with-mate");
});

test("a refused ops close removes nothing and closes Done once the unexpected file is gone", async () => {
  dispatchOperation();
  const seen: string[] = [];
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    writeFileSync(join(tree, "scratch-pad.txt"), "oops\n");
    return written(report);
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Operation complete" } }), "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    unlinkSync(join(tree, "scratch-pad.txt"));
    return { tool: "close", args: { card: 1, summary: "Operation complete" } };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { text: "closed" };
  }, "mate");
  await start();
  await finished(5);
  assert.match(seen[0] ?? "", /scratch-pad\.txt/);
  assert.match(seen[1] ?? "", /^c-1 is done\. Evidence kept at local:/);
  assert.equal(existsSync(tree), false);
  assert.equal((await cardd.thread(1)).card.status, "done");
});

test("ops refuses Done when its registered worktree is gone, and keeps the card open", async () => {
  dispatchOperation();
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    const placed = written(report);
    git(scratch.root, "worktree", "remove", "--force", tree);
    return placed;
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Operation complete" } }), "mate");
  h.onModel(() => ({ text: "close attempted" }), "mate");
  await start();
  const refused = toolResults(await finished(4)).at(-1) ?? "";
  assert.match(refused, /has no registered worktree on local to check, so nothing was removed/);
  assert.equal((await cardd.thread(1)).card.status, "with-mate");
});

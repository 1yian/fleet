import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  branchesOf,
  lastUser,
  mateConnected as connected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  worktreesOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import type { FakeGitHub } from "../support/github.ts";
import type { Harness, Pi } from "../support/harness.ts";

let parts: DispatchLab;
let h: Harness;
let clone: string;
let mate: Pi;
let gh: FakeGitHub;
beforeEach(async () => {
  parts = await startDispatchLab();
  ({ h, clone, mate } = parts);
  gh = parts.cardd.gh;
});
afterEach(async () => {
  await stopDispatchLab(parts);
});

const mateConnected = () => connected(h);

function scriptOperation(work: Parameters<Harness["onModel"]>[0]): void {
  parts.cardd.yolo("site");
  h.onModel(
    () => ({
      tool: "card_new",
      args: { title: "Add credit", name: "add-credit", kind: "ship", project: "site" },
    }),
    "mate",
  );
  h.onModel(
    () => ({ tool: "dispatch", args: { card: 1, host: "local", task: "add the credit" } }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
  h.onModel(work, "worker");
}

test("close finds that an operation landed, closes it as Done, and removes its worktree", async () => {
  scriptOperation(() => ({ tool: "report", args: { status: "done", text: "credit added" } }));
  h.onModel(
    () => ({ tool: "close", args: { card: 1, summary: "Added $10. No code change." } }),
    "mate",
  );
  await mateConnected();
  mate.prompt("add credit");

  const results = toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS));
  assert.equal(results.at(-1), "c-1 is done.");
  assert.equal(existsSync(`${clone}.archive`), false);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  assert.deepEqual(branchesOf(clone), ["main"]);
  assert.deepEqual(await workersOf(parts.lab), []);
});

test("close refuses Done for work that did not land and leaves it in place; landed=false drops it and archives it", async () => {
  scriptOperation(() => {
    const tree = `${clone}.worktrees/c-1-a1`;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", tree, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    writeFileSync(join(tree, "fix.txt"), "one\n");
    git("add", "fix.txt");
    git("commit", "-q", "-m", "the fix");
    writeFileSync(join(tree, "scratch.txt"), "two\n");
    return { tool: "report", args: { status: "done", text: "fixed" } };
  });
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Done." } }), "mate");
  h.onModel((turns) => {
    assert.equal(
      toolResults(turns).at(-1),
      "c-1 did not land: c-1-a1 on local has 1 commit not on main and 1 uncommitted file. Land it, or end it with close(card, summary=<why it is dropped>, landed=false), which archives it.",
    );
    assert.equal(worktreesOf(clone).length, 2);
    return { tool: "close", args: { card: 1, summary: "The fix is not wanted.", landed: false } };
  }, "mate");
  await mateConnected();
  mate.prompt("add credit");

  const results = toolResults(await h.waitForCall(5, "mate", WORKER_WAIT_MS));
  const archive = `${clone}.archive/c-1-a1.tar.zst`;
  assert.equal(results.at(-1), `c-1 is dropped. Unlanded work is archived in local:${archive}.`);
  assert.equal(existsSync(archive), true);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  assert.deepEqual(await workersOf(parts.lab), []);
});

test("with yolo on, the mate comments the worker to merge without asking; the worker merges, and close closes the card at once", async () => {
  const pr = "https://github.com/acme/site/pull/3";
  gh.setPr(pr, "OPEN", { ci: "pass" });
  gh.setHead(pr, "c-1-a1");
  scriptOperation(() => ({ tool: "report", args: { status: "done", text: "credit added" } }));
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel((turns) => {
    assert.match(lastUser(turns) ?? "", /Merge your PR now/);
    execFileSync("gh", ["pr", "merge", pr, "--squash"], { env: { ...process.env, ...gh.env } });
    return { tool: "report", args: { status: "done", text: "merged it" } };
  }, "worker");
  h.onModel(() => ({ tool: "comment", args: { card: 1, text: "Merge your PR now." } }), "mate");
  h.onModel(() => ({ text: "asked the worker to merge" }), "mate");
  h.onModel(
    () => ({ tool: "close", args: { card: 1, summary: `Added the credit in ${pr}.` } }),
    "mate",
  );
  await mateConnected();
  mate.prompt("add credit");

  const asked = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.equal(
    lastUser(asked),
    `[fleet] c-1 add-credit done: credit added (PR ${pr}) (card now merging)`,
  );
  const merged = await h.waitForCall(5, "mate", WORKER_WAIT_MS);
  assert.equal(gh.state(pr), "MERGED");
  assert.equal(
    lastUser(merged),
    `[fleet] c-1 add-credit done: merged it (PR ${pr}, merged) (card now merging)`,
  );
  const results = toolResults(await h.waitForCall(6, "mate", WORKER_WAIT_MS));
  assert.equal(results.at(-1), "c-1 is done.");
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  assert.deepEqual(await workersOf(parts.lab), []);
});

test("a ship card done with no PR on its branch reaches the mate, which asks the worker to open one", async () => {
  const pr = "https://github.com/acme/site/pull/4";
  scriptOperation(() => ({ tool: "report", args: { status: "done", text: "fixed" } }));
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel((turns) => {
    assert.match(lastUser(turns) ?? "", /Open your PR/);
    gh.setPr(pr, "OPEN", { ci: "pass" });
    gh.setHead(pr, "c-1-a1");
    return { tool: "report", args: { status: "done", text: "PR opened" } };
  }, "worker");
  h.onModel(
    () => ({ tool: "comment", args: { card: 1, text: "Open your PR from your task branch." } }),
    "mate",
  );
  h.onModel(() => ({ text: "asked for the PR" }), "mate");
  h.onModel(() => ({ text: "the PR is open" }), "mate");
  await mateConnected();
  mate.prompt("add credit");

  const missing = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.equal(
    lastUser(missing),
    "[fleet] c-1 add-credit done: fixed (no PR has branch c-1-a1 as its head) (card now merging)",
  );
  const found = await h.waitForCall(5, "mate", WORKER_WAIT_MS);
  assert.equal(
    lastUser(found),
    `[fleet] c-1 add-credit done: PR opened (PR ${pr}) (card now merging)`,
  );
});

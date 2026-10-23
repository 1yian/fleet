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
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Add credit",
        name: "add-credit",
        kind: "ship",
        project: "site",
        intent: "Fix the scrollbar",
        host: "local",
        task: "add the credit",
      },
    }),
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

function squashFromAnotherBranch(): void {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("checkout", "-q", "-b", "landed-elsewhere");
  writeFileSync(join(clone, "fix.txt"), "one\n");
  git("add", "fix.txt");
  git("commit", "-q", "-m", "landed through another card");
  git("checkout", "-q", "main");
  git("merge", "--squash", "landed-elsewhere");
  git("commit", "-q", "-m", "squash another card");
  git("branch", "-D", "landed-elsewhere");
}

function assertArchive(archive: string): void {
  const packed = execFileSync("zstd", ["-dc", archive]);
  const files = execFileSync("tar", ["-tf", "-"], { input: packed, encoding: "utf8" });
  assert.match(files, /c-1-a1\/commits\.bundle/);
  const untracked = execFileSync("tar", ["-xOf", "-", "c-1-a1/untracked.tar"], { input: packed });
  const scratch = execFileSync("tar", ["-xOf", "-", "scratch.txt"], {
    input: untracked,
    encoding: "utf8",
  });
  assert.equal(scratch, "two\n");
}

function assertWarned(text: string | undefined): void {
  assert.ok(text !== undefined);
  assert.match(
    text,
    /^c-1 was not closed\. c-1-a1 on local has 1 commit not on main and 1 uncommitted file:\n/,
  );
  assert.match(text, /^ {2}commit c-1-a1: [0-9a-f]+ the fix$/m);
  assert.match(text, /^ {2}file c-1-a1: \?\? scratch\.txt$/m);
  assert.match(text, /call close again with confirm=true/);
}

test("close warns about unlanded work and leaves the card open; confirm=true ends it Done and archives the work first", async () => {
  scriptOperation(() => {
    const tree = `${clone}.worktrees/c-1-a1`;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", tree, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    writeFileSync(join(tree, "fix.txt"), "one\n");
    git("add", "fix.txt");
    git("commit", "-q", "-m", "the fix");
    writeFileSync(join(tree, "scratch.txt"), "two\n");
    squashFromAnotherBranch();
    return { tool: "report", args: { status: "done", text: "fixed" } };
  });
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Landed elsewhere." } }), "mate");
  h.onModel((turns) => {
    assertWarned(toolResults(turns).at(-1));
    assert.equal(worktreesOf(clone).length, 2);
    return { tool: "close", args: { card: 1, summary: "Landed elsewhere.", confirm: true } };
  }, "mate");
  await mateConnected();
  mate.prompt("add credit");

  const results = toolResults(await h.waitForCall(5, "mate", WORKER_WAIT_MS));
  const archive = `${clone}.archive/c-1-a1.tar.zst`;
  assert.equal(results.at(-1), `c-1 is done. Unlanded work is archived in local:${archive}.`);
  assertArchive(archive);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  assert.deepEqual(await workersOf(parts.lab), []);
});

test("a merged report for a PR from another branch closes the card Done on its own and archives the leftover commits", async () => {
  const pr = "https://github.com/acme/site/pull/381";
  gh.setPr(pr, "MERGED");
  scriptOperation(() => {
    const tree = `${clone}.worktrees/c-1-a1`;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", tree, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    writeFileSync(join(tree, "fix.txt"), "one\n");
    git("add", "fix.txt");
    git("commit", "-q", "-m", "the fix");
    writeFileSync(join(tree, "scratch.txt"), "two\n");
    squashFromAnotherBranch();
    return { tool: "report", args: { status: "merged", text: "landed in another card", pr } };
  });
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel((turns) => {
    const message = lastUser(turns) ?? "";
    const archive = `${clone}.archive/c-1-a1.tar.zst`;
    assert.match(message, /^\[fleet\] c-1 .*merged: landed in another card/);
    assert.ok(
      message.includes(
        `Closed automatically: c-1 is done. Unlanded work is archived in local:${archive}.`,
      ),
    );
    return { text: "relayed" };
  }, "mate");
  await mateConnected();
  mate.prompt("add credit");

  await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assertArchive(`${clone}.archive/c-1-a1.tar.zst`);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  assert.deepEqual(await workersOf(parts.lab), []);
});

test("close warns about work that did not land and leaves it in place; landed=false drops it and archives it", async () => {
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
    assertWarned(toolResults(turns).at(-1));
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
  gh.setPr(pr, "OPEN");
  scriptOperation(() => ({ tool: "report", args: { status: "done", text: "credit added", pr } }));
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel((turns) => {
    assert.match(lastUser(turns) ?? "", /Merge your PR now/);
    execFileSync("gh", ["pr", "merge", pr, "--squash"], { env: { ...process.env, ...gh.env } });
    return { tool: "report", args: { status: "done", text: "merged it", pr, merged: true } };
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
    return { tool: "report", args: { status: "done", text: "PR opened", pr } };
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
    "[fleet] c-1 add-credit done: fixed (no PR URL reported: the worker reports it with report(pr=<full url>)) (card now merging)",
  );
  const found = await h.waitForCall(5, "mate", WORKER_WAIT_MS);
  assert.equal(
    lastUser(found),
    `[fleet] c-1 add-credit done: PR opened (PR ${pr}) (card now merging)`,
  );
});

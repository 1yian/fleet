import assert from "node:assert/strict";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  branchesOf,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import type { Harness } from "../support/harness.ts";
import { git, landOnRemote as landOn, tip } from "../support/remote.ts";

let parts: DispatchLab;
let h: Harness;
let clone: string;
let remote: string;
beforeEach(async () => {
  parts = await startDispatchLab({ remote: true });
  ({ h, clone } = parts);
  remote = parts.remote ?? "";
  writeFileSync(join(clone, "README"), "site\n");
  git(clone, "add", "README");
  git(clone, "commit", "-q", "-m", "readme");
  git(clone, "push", "-q", "origin", "main");
});
afterEach(async (t) => {
  await parts.lab.printIfFailed(t);
  await stopDispatchLab(parts);
});

const short = (sha: string): string => sha.slice(0, 7);
const landOnRemote = (message: string): string => landOn(remote, message);

function pushedBranch(name: string): string {
  git(clone, "branch", name);
  git(clone, "push", "-q", "-u", "origin", name);
  return tip(clone, name);
}

const deleteOnRemote = (name: string): void => {
  git(remote, "branch", "-q", "-D", name);
};

function scriptCard(beforeDone: () => void = () => undefined): void {
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
  h.onModel(() => {
    beforeDone();
    return { tool: "report", args: { status: "done", text: "credit added" } };
  }, "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Added $10." } }), "mate");
  h.onModel(() => ({ text: "closed" }), "mate");
}

async function closeResult(): Promise<string> {
  await mateConnected(h);
  parts.mate.prompt("add credit");
  return toolResults(await h.waitForCall(4, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
}

test("dispatch fetches origin and branches the worktree from origin's base, which is ahead of the clone", async () => {
  const stale = tip(clone);
  const fresh = landOnRemote("merged-elsewhere");
  scriptCard();
  await mateConnected(h);
  parts.mate.prompt("add credit");
  await h.waitForCall(2, "mate", WORKER_WAIT_MS);

  assert.notEqual(stale, fresh);
  assert.equal(tip(`${clone}.worktrees/c-1-a1`, "HEAD"), fresh);
  assert.equal(git(clone, "for-each-ref", "--format=%(upstream)", "refs/heads/c-1-a1"), "");
});

test("close refreshes the clone: it fast-forwards a clean base and prunes a branch whose remote branch is gone", async () => {
  const stale = tip(clone);
  const gone = pushedBranch("old-fix");
  deleteOnRemote("old-fix");
  scriptCard(() => landOnRemote("merged-pr"));
  const result = await closeResult();
  const fresh = tip(remote);

  assert.equal(
    result,
    `c-1 is done. Clones: site on local: pruned old-fix (was ${short(gone)}); site on local: synced ${short(stale)}..${short(fresh)}.`,
  );
  assert.equal(tip(clone), fresh);
  assert.deepEqual(branchesOf(clone), ["main"]);
});

test("close leaves a dirty clone alone and reports it", async () => {
  const stale = tip(clone);
  scriptCard(() => {
    landOnRemote("merged-pr");
    writeFileSync(join(clone, "README"), "the captain's edit\n");
  });
  const result = await closeResult();

  assert.equal(
    result,
    "c-1 is done. Clones: site on local: STUCK: on branch main with uncommitted changes, 1 commits behind origin/main - needs attention.",
  );
  assert.equal(tip(clone), stale);
  assert.equal(readFileSync(join(clone, "README"), "utf8"), "the captain's edit\n");
});

test("dispatch waits out a stale packed-refs.lock left by a killed git, removes it, and fetches", async () => {
  pushedBranch("old-fix");
  deleteOnRemote("old-fix");
  const lock = join(clone, ".git", "packed-refs.lock");
  writeFileSync(lock, "");
  const hourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(lock, hourAgo, hourAgo);
  const fresh = landOnRemote("merged-elsewhere");
  scriptCard();
  await mateConnected(h);
  parts.mate.prompt("add credit");
  const results = toolResults(await h.waitForCall(2, "mate", WORKER_WAIT_MS));

  assert.match(results.at(-1) ?? "", /^Dispatched c-1-a1 on local, branch c-1-a1\.$/);
  assert.equal(existsSync(lock), false);
  assert.equal(tip(`${clone}.worktrees/c-1-a1`, "HEAD"), fresh);
  assert.equal(git(clone, "branch", "-r", "--list", "origin/old-fix"), "");
});

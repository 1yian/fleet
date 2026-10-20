// cleanup's landing test on the host (spec section 20.5), through a real mate Pi, a real
// worker Pi in a herdr lab, and a real git worktree: nothing unlanded closes the card as Done.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  branchesOf,
  mateConnected as connected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  worktreesOf,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import type { Harness, Pi } from "../support/harness.ts";

let parts: DispatchLab;
let h: Harness;
let clone: string;
let mate: Pi;
beforeEach(async () => {
  parts = await startDispatchLab();
  ({ h, clone, mate } = parts);
});
afterEach(async () => {
  await stopDispatchLab(parts);
});

const mateConnected = () => connected(h);

/** The mate grants merging, makes a ship card, and dispatches it; the worker's script is `work`. */
function scriptOperation(work: Parameters<Harness["onModel"]>[0]): void {
  h.onModel(
    () => ({
      tool: "grant",
      args: {
        lane: "main",
        project: "site",
        words: "You may merge site when CI is green",
        may: "merge when CI is green",
        merge: true,
      },
    }),
    "mate",
  );
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

test("cleanup closes a ship card that only did an operation as Done, and removes its worktree", async () => {
  scriptOperation(() => ({ tool: "report", args: { status: "done", text: "credit added" } }));
  h.onModel(
    () => ({
      tool: "cleanup",
      args: { card: 1, summary: "Added $10. No code change.", without_pr: true },
    }),
    "mate",
  );
  await mateConnected();
  mate.prompt("add credit. You may merge site when CI is green.");

  const results = toolResults(await h.waitForCall(5, "mate", WORKER_WAIT_MS));
  assert.equal(results.at(-1), "c-1 is done.");
  // Nothing was unlanded, so there is nothing to archive.
  assert.equal(existsSync(`${clone}.archive`), false);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  assert.deepEqual(branchesOf(clone), ["main"]);
  assert.deepEqual(await workersOf(parts.lab), []);
});

test("cleanup refuses a ship card that has unlanded work, and leaves the worktree in place", async () => {
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
  h.onModel(
    () => ({ tool: "cleanup", args: { card: 1, summary: "Done.", without_pr: true } }),
    "mate",
  );
  await mateConnected();
  mate.prompt("add credit. You may merge site when CI is green.");

  const results = toolResults(await h.waitForCall(5, "mate", WORKER_WAIT_MS));
  assert.equal(
    results.at(-1),
    "c-1 has unlanded work, so it cannot close as Done: c-1-a1 on local has 1 commit not on main and 1 uncommitted file. Land it, or use card_drop, which archives it.",
  );
  assert.equal(worktreesOf(clone).length, 2);
  assert.deepEqual(await workersOf(parts.lab), ["c-1-a1"]);
});

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  branchesOf,
  lastUser,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  worktreesOf,
  type DispatchLab,
  type LabOptions,
} from "../support/dispatch-lab.ts";
import type { Harness } from "../support/harness.ts";
import { git, tip } from "../support/remote.ts";

let parts: DispatchLab | undefined;
afterEach(async () => {
  if (parts !== undefined) await stopDispatchLab(parts);
  parts = undefined;
});

async function lab(options: LabOptions): Promise<DispatchLab> {
  parts = await startDispatchLab(options);
  return parts;
}

const treeOf = (clone: string): string => `${clone}.worktrees/c-1-a1`;
const branchIn = (tree: string): string => git(tree, "branch", "--show-current");
const SHAPE =
  "must be <type>/<slug>, with a type of feat, fix, refactor, perf, docs, test, chore, ci, build and a lowercase kebab-case slug of at most 48 characters, such as fix/mileage-readback";

type Args = Readonly<Record<string, string | number>>;

function mateMoves(h: Harness, moves: readonly (readonly [string, Args] | string)[]): void {
  for (const move of moves)
    h.onModel(
      () => (typeof move === "string" ? { text: move } : { tool: move[0], args: move[1] }),
      "mate",
    );
}

const CARD_NEW = [
  "card_new",
  { title: "Add credit", name: "add-credit", kind: "ship", project: "site" },
] as const;
const dispatch = (more: Args = {}) =>
  ["dispatch", { card: 1, host: "local", task: "add the credit", ...more }] as const;
const resultOf = async (h: Harness, call: number): Promise<string> =>
  toolResults(await h.waitForCall(call, "mate", WORKER_WAIT_MS)).at(-1) ?? "";

function commitIn(repo: string, file: string): string {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", file);
  return tip(repo, "HEAD");
}

test("a worker names its branch, the fleet finds its PR by that name, and close sees the work land", async () => {
  const p = await lab({});
  const { h, mate, clone } = p;
  const { gh } = p.cardd;
  p.cardd.yolo("site");
  const pr = "https://github.com/acme/site/pull/9";
  h.onModel(() => ({ tool: "branch", args: { name: "fix/credit-readback" } }), "worker");
  h.onModel((turns) => {
    assert.equal(
      toolResults(turns).at(-1),
      "Renamed c-1-a1 to fix/credit-readback and recorded it as your task branch. Open your PR from it.",
    );
    assert.equal(branchIn(treeOf(clone)), "fix/credit-readback");
    assert.deepEqual(branchesOf(clone).sort(), ["fix/credit-readback", "main"]);
    gh.setPr(pr, "OPEN", { ci: "pass" });
    gh.setHead(pr, "fix/credit-readback");
    return { tool: "report", args: { status: "done", text: "PR opened" } };
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  mateMoves(h, [CARD_NEW, dispatch(), "dispatched", ["board", { card: 1 }]]);
  h.onModel(() => {
    gh.setPr(pr, "MERGED");
    return { tool: "close", args: { card: 1, summary: `Added the credit in ${pr}.` } };
  }, "mate");
  h.onModel(() => ({ text: "closed" }), "mate");
  await mateConnected(h);
  mate.prompt("add credit");

  const done = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.equal(
    lastUser(done),
    `[fleet] c-1 add-credit done: PR opened (PR ${pr}) (card now merging)`,
  );
  const view = await resultOf(h, 4);
  assert.match(view, /fix\/credit-readback/);
  assert.doesNotMatch(view, /branch: c-1-a1/);
  assert.equal(await resultOf(h, 5), "c-1 is done.");
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  assert.deepEqual(branchesOf(clone), ["main"]);
});

test("a malformed name, a name taken in the clone, and a name taken on origin are refused, and the branch stays as it was", async () => {
  const p = await lab({ remote: true });
  const { h, mate, clone } = p;
  const refuse = (name: string) => ({ tool: "branch", args: { name } });
  h.onModel(() => refuse("readback"), "worker");
  h.onModel((turns) => {
    assert.equal(toolResults(turns).at(-1), `branch name "readback" ${SHAPE}`);
    return refuse("fix/Credit_Readback");
  }, "worker");
  h.onModel((turns) => {
    assert.equal(toolResults(turns).at(-1), `branch name "fix/Credit_Readback" ${SHAPE}`);
    git(clone, "branch", "fix/taken-here", "main");
    return refuse("fix/taken-here");
  }, "worker");
  h.onModel((turns) => {
    assert.equal(
      toolResults(turns).at(-1),
      "branch fix/taken-here already exists in this clone: choose a different slug",
    );
    git(clone, "push", "-q", "origin", "main:refs/heads/chore/on-origin");
    return refuse("chore/on-origin");
  }, "worker");
  h.onModel((turns) => {
    assert.equal(
      toolResults(turns).at(-1),
      "branch chore/on-origin already exists on origin: choose a different slug",
    );
    assert.equal(branchIn(treeOf(clone)), "c-1-a1");
    return refuse("fix/free-name");
  }, "worker");
  h.onModel((turns) => {
    assert.match(toolResults(turns).at(-1) ?? "", /^Renamed c-1-a1 to fix\/free-name/);
    return refuse("fix/second-name");
  }, "worker");
  h.onModel((turns) => {
    assert.equal(
      toolResults(turns).at(-1),
      "c-1-a1 already has its branch fix/free-name. Keep working on it: a branch is named once",
    );
    assert.equal(branchIn(treeOf(clone)), "fix/free-name");
    return { tool: "report", args: { status: "blocked", text: "stopping here" } };
  }, "worker");
  h.onModel(() => ({ text: "stopped" }), "worker");
  mateMoves(h, [CARD_NEW, dispatch(), "dispatched", ["board", { card: 1 }], "saw the card"]);
  await mateConnected(h);
  mate.prompt("add credit");

  assert.match(await resultOf(h, 4), /fix\/free-name/);
  assert.deepEqual(branchesOf(clone).sort(), ["fix/free-name", "fix/taken-here", "main"]);
});

test("a local-only worker names its branch, and close fast-forwards local main with that branch", async () => {
  const p = await lab({ delivery: "local-only" });
  const { h, mate, clone } = p;
  p.cardd.yolo("site");
  const fix: { sha?: string } = {};
  h.onModel(() => ({ tool: "branch", args: { name: "feat/credit-file" } }), "worker");
  h.onModel(() => {
    fix.sha = commitIn(treeOf(clone), "credit.txt");
    return { tool: "report", args: { status: "done", text: "branch feat/credit-file ready" } };
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  mateMoves(h, [
    CARD_NEW,
    dispatch(),
    "dispatched",
    ["close", { card: 1, summary: "Added the credit." }],
    "landed",
  ]);
  await mateConnected(h);
  mate.prompt("add credit, only locally");

  const done = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.equal(
    lastUser(done),
    "[fleet] c-1 add-credit done: branch feat/credit-file ready (local-only: branch feat/credit-file lands on local main when the card closes) (card now merging)",
  );
  assert.match(
    await resultOf(h, 4),
    /^c-1 is done\. Landed feat\/credit-file on local main on local \(\w+\.\.\w+\)\.$/,
  );
  assert.equal(tip(clone), fix.sha);
  assert.deepEqual(branchesOf(clone), ["main"]);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
});

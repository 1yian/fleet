import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
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
  workersOf,
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
const READY =
  "branch c-1-a1 ready (local-only: branch c-1-a1 lands on local main when the card closes)";

function commitIn(repo: string, file: string): string {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", file);
  return tip(repo, "HEAD");
}

type Args = Readonly<Record<string, string | number>>;

function mateMoves(h: Harness, moves: readonly (readonly [string, Args] | string)[]): void {
  for (const move of moves)
    h.onModel(
      () => (typeof move === "string" ? { text: move } : { tool: move[0], args: move[1] }),
      "mate",
    );
}

const CARD_NEW = ["board", {}] as const;
const dispatch = (more: Args = {}) =>
  [
    "dispatch",
    {
      title: "Add credit",
      name: "add-credit",
      kind: "ship",
      project: "site",
      intent: "Add the credit",
      host: "local",
      task: "add the credit",
      ...more,
    },
  ] as const;
const taskFor = (mode: string) =>
  `[fleet] main on c-1 add-credit: add the credit\n\nDelivery: ${mode}`;
const after = async (h: Harness, call: number) => {
  await h.waitForCall(call, "mate", WORKER_WAIT_MS);
};
const resultOf = async (h: Harness, call: number): Promise<string> =>
  toolResults(await h.waitForCall(call, "mate", WORKER_WAIT_MS)).at(-1) ?? "";

async function approveOnBoard({ cardd }: DispatchLab, question: string): Promise<void> {
  const hold = (await cardd.board()).holds.find((each) => each.card === 1);
  assert.ok(hold !== undefined);
  assert.equal(hold.question, question);
  const answer = { kind: "answer", hold: hold.hold, choice: "Approve & merge" } as const;
  assert.equal(await cardd.act(1, answer), 200);
}

function workerMerges(h: Harness, p: DispatchLab, pr: string): void {
  h.onModel((turns) => {
    assert.match(lastUser(turns) ?? "", /Merge your PR now/);
    const env = { ...process.env, ...p.cardd.gh.env };
    execFileSync("gh", ["pr", "merge", pr, "--squash"], { env });
    return { tool: "report", args: { status: "done", text: `merged ${pr}`, pr, merged: true } };
  }, "worker");
  h.onModel(() => ({ text: "merged" }), "worker");
}

test("no-mistakes: the worker gets its mode from the card, the pipeline's done reaches the mate with its PR and no other gate, and the card lands when the PR merges", async () => {
  const p = await lab({});
  const { h, mate } = p;
  const { gh } = p.cardd;
  const pr = "https://github.com/acme/site/pull/7";
  h.onModel(async (turns) => {
    assert.equal(lastUser(turns), taskFor("no-mistakes"));
    await after(h, 2);
    return { tool: "report", args: { status: "in-review", text: "validation started" } };
  }, "worker");
  h.onModel(() => {
    gh.setPr(pr, "OPEN");
    return { tool: "report", args: { status: "done", text: `PR ${pr} checks green`, pr } };
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  workerMerges(h, p, pr);
  mateMoves(h, [
    CARD_NEW,
    dispatch(),
    "dispatched",
    "the pipeline runs",
    ["board", { card: 1 }],
    "asked the captain",
    ["comment", { card: 1, text: "Merge your PR now." }],
    "asked the worker to merge",
    ["close", { card: 1, summary: `Added the credit in ${pr}.` }],
  ]);
  await mateConnected(h);
  mate.prompt("add credit");

  const inReview = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.equal(lastUser(inReview), "[fleet] c-1 add-credit in-review: validation started");
  const done = await h.waitForCall(4, "mate", WORKER_WAIT_MS);
  assert.equal(
    lastUser(done),
    `[fleet] c-1 add-credit done: PR ${pr} checks green (PR ${pr}) (card now needs-you)`,
  );
  const view = await resultOf(h, 5);
  assert.match(view, /^ {2}delivery: no-mistakes$/m);
  assert.match(
    view,
    /^hold:\n {2}waits: captain\n {2}question: "Merge \S+ for c-1: Add credit\?"$/m,
  );
  await approveOnBoard(p, `Merge ${pr} for c-1: Add credit?`);

  const approved = await h.waitForCall(6, "mate", WORKER_WAIT_MS);
  assert.equal(lastUser(approved), "[fleet] captain on c-1 add-credit (answer): Approve & merge");
  const merged = await h.waitForCall(8, "mate", WORKER_WAIT_MS);
  assert.equal(
    lastUser(merged),
    `[fleet] c-1 add-credit done: merged ${pr} (PR ${pr}, merged) (card now merging)`,
  );
  assert.equal(await resultOf(h, 9), "c-1 is done.");
  assert.equal(gh.state(pr), "MERGED");
});

test("direct-PR: the card takes its project's mode, a task that names another mode is refused, and with yolo on the opened PR goes straight to merging and lands", async () => {
  const p = await lab({ delivery: "direct-PR" });
  const { h, mate, clone } = p;
  const { gh } = p.cardd;
  p.cardd.yolo("site");
  const pr = "https://github.com/acme/site/pull/8";
  h.onModel(async (turns) => {
    assert.equal(lastUser(turns), taskFor("direct-PR"));
    await after(h, 3);
    gh.setPr(pr, "OPEN");
    return { tool: "report", args: { status: "done", text: `PR ${pr} opened`, pr } };
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  workerMerges(h, p, pr);
  mateMoves(h, [
    CARD_NEW,
    dispatch({ task: "add the credit\n\nDelivery: no-mistakes" }),
    dispatch(),
    "dispatched",
    ["board", {}],
    ["comment", { card: 1, text: "Merge your PR now." }],
    "asked the worker to merge",
    ["close", { card: 1, summary: `Added the credit in ${pr}.` }],
  ]);
  await mateConnected(h);
  mate.prompt("add credit");

  assert.equal(
    await resultOf(h, 2),
    'the task says Delivery: no-mistakes, but c-1 delivers direct-PR. Leave the Delivery line out, since dispatch adds it from the card, or pass delivery="no-mistakes" to dispatch when the captain asked for that mode',
  );
  const done = await h.waitForCall(4, "mate", WORKER_WAIT_MS);
  assert.equal(
    lastUser(done),
    `[fleet] c-1 add-credit done: PR ${pr} opened (PR ${pr}) (card now merging)`,
  );
  const board = await resultOf(h, 5);
  assert.match(board, /^ {2}site,direct-PR,local flaky far,on$/m);
  assert.match(
    board,
    /^cards\[1\]\{card,status,waits,delivery,title\}:\n {2}1,merging,merge,direct-PR,Add credit$/m,
  );
  assert.equal(await resultOf(h, 8), "c-1 is done.");
  assert.equal(gh.state(pr), "MERGED");
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
});

test("local-only on the mate's word: the ready branch raises the landing question with no PR, and on the captain's approval close fast-forwards local main and closes the card", async () => {
  const p = await lab({});
  const { h, mate, clone } = p;
  const fix: { sha?: string } = {};
  h.onModel(async (turns) => {
    assert.equal(lastUser(turns), taskFor("local-only"));
    await after(h, 2);
    fix.sha = commitIn(treeOf(clone), "credit.txt");
    return { tool: "report", args: { status: "done", text: "branch c-1-a1 ready" } };
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  mateMoves(h, [
    CARD_NEW,
    dispatch({ delivery: "local-only" }),
    "dispatched",
    ["close", { card: 1, summary: "Added the credit." }],
    ["board", { card: 1 }],
    "asked the captain",
    ["close", { card: 1, summary: "Added the credit." }],
    "landed",
  ]);
  await mateConnected(h);
  mate.prompt("add credit, only locally");

  const done = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.equal(lastUser(done), `[fleet] c-1 add-credit done: ${READY} (card now needs-you)`);
  assert.match(await resultOf(h, 4), /^c-1 has an open hold/);
  const before = tip(clone);
  assert.notEqual(before, fix.sha);
  const view = await resultOf(h, 5);
  assert.match(view, /^ {2}delivery: local-only$/m);
  assert.match(view, /^ {2}pr: none$/m);
  await approveOnBoard(p, "Land branch c-1-a1 on local main for c-1: Add credit?");

  const approved = await h.waitForCall(6, "mate", WORKER_WAIT_MS);
  assert.equal(lastUser(approved), "[fleet] captain on c-1 add-credit (answer): Approve & merge");
  const short = (sha: string) => git(clone, "rev-parse", "--short", sha);
  assert.equal(
    await resultOf(h, 7),
    `c-1 is done. Landed c-1-a1 on local main on local (${short(before)}..${short(fix.sha ?? "")}).`,
  );
  assert.equal(tip(clone), fix.sha);
  assert.equal(existsSync(`${clone}.archive`), false);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  assert.deepEqual(branchesOf(clone), ["main"]);
  assert.deepEqual(await workersOf(p.lab), []);
});

test("a local-only project with an origin starts from local main, refuses a stale branch until the worker rebases, lands with yolo on, and never touches origin", async () => {
  const p = await lab({ remote: true, delivery: "local-only" });
  const { h, mate, clone, remote } = p;
  p.cardd.yolo("site");
  const origin = tip(remote ?? "");
  const earlier = commitIn(clone, "earlier.txt");
  const moved: { sha?: string } = {};
  h.onModel(async (turns) => {
    assert.equal(lastUser(turns), taskFor("local-only"));
    assert.equal(existsSync(join(treeOf(clone), "earlier.txt")), true);
    await after(h, 2);
    commitIn(treeOf(clone), "credit.txt");
    moved.sha = commitIn(clone, "moved.txt");
    return { tool: "report", args: { status: "done", text: "branch c-1-a1 ready" } };
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel((turns) => {
    assert.match(lastUser(turns) ?? "", /Rebase onto main/);
    git(treeOf(clone), "rebase", "-q", "main");
    return { tool: "report", args: { status: "done", text: "branch c-1-a1 ready" } };
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  mateMoves(h, [
    CARD_NEW,
    dispatch(),
    "dispatched",
    ["close", { card: 1, summary: "Added the credit." }],
    ["comment", { card: 1, text: "Rebase onto main, then report done." }],
    "asked for a rebase",
    ["close", { card: 1, summary: "Added the credit." }],
    "landed",
  ]);
  await mateConnected(h);
  mate.prompt("add credit");

  const done = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.equal(lastUser(done), `[fleet] c-1 add-credit done: ${READY} (card now merging)`);
  assert.match(
    await resultOf(h, 4),
    /^c-1 did not land: .*c-1-a1 is not a fast-forward of main: have the worker rebase it onto main$/,
  );
  assert.equal(tip(clone), moved.sha);
  const again = await h.waitForCall(6, "mate", WORKER_WAIT_MS);
  assert.equal(lastUser(again), `[fleet] c-1 add-credit done: ${READY} (card now merging)`);
  assert.match(
    await resultOf(h, 7),
    /^c-1 is done\. Landed c-1-a1 on local main on local \(\w+\.\.\w+\)\.$/,
  );
  assert.deepEqual(git(clone, "log", "--format=%s", "main").split("\n"), [
    "credit.txt",
    "moved.txt",
    "earlier.txt",
    "init",
  ]);
  assert.notEqual(earlier, origin);
  assert.equal(tip(remote ?? ""), origin);
  assert.deepEqual(worktreesOf(clone), ["branch refs/heads/main"]);
  assert.deepEqual(branchesOf(clone), ["main"]);
});

test("local-only with nothing to land: a done report on an empty clean branch opens no land hold, and the mate closes the card as done", async () => {
  const p = await lab({});
  const { h, mate } = p;
  h.onModel(async (turns) => {
    assert.equal(lastUser(turns), taskFor("local-only"));
    await after(h, 2);
    return { tool: "report", args: { status: "done", text: "operation finished, no code change" } };
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  mateMoves(h, [
    CARD_NEW,
    dispatch({ delivery: "local-only" }),
    "dispatched",
    ["close", { card: 1, summary: "Operation finished." }],
    "closed",
  ]);
  await mateConnected(h);
  mate.prompt("run the operation, only locally");

  const done = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.match(lastUser(done) ?? "", /^\[fleet\] c-1 add-credit done: operation finished/);
  assert.match(await resultOf(h, 4), /^c-1 is done\./);
  assert.deepEqual(await workersOf(p.lab), []);
});

test("local-only with a commit keeps the land hold on done", async () => {
  const p = await lab({});
  const { h, mate, clone } = p;
  h.onModel(async () => {
    await after(h, 2);
    commitIn(treeOf(clone), "credit.txt");
    return { tool: "report", args: { status: "done", text: "branch c-1-a1 ready" } };
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  mateMoves(h, [
    CARD_NEW,
    dispatch({ delivery: "local-only" }),
    "dispatched",
    ["close", { card: 1, summary: "Added the credit." }],
    "asked the captain",
  ]);
  await mateConnected(h);
  mate.prompt("add credit, only locally");

  const done = await h.waitForCall(3, "mate", WORKER_WAIT_MS);
  assert.match(lastUser(done) ?? "", /needs-you/);
  assert.match(await resultOf(h, 4), /^c-1 has an open hold/);
});

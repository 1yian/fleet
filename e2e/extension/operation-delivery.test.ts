import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
    assert.match(contract, /### Delivery: ops/);
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
  await finished(5);
  assert.match(seen[0] ?? "", /^\s*evidence: "?reported, shape-checked only and not verified/m);
  assert.doesNotMatch(seen[1] ?? "", /evidence: /);
});

test("closing an ops card is refused in every mode, and after each refusal the same worker, refs, files and scratch remain", async () => {
  dispatchOperation();
  const pidFile = join(h.dir, "worker.pid");
  const snaps: unknown[] = [];
  const answers: string[] = [];
  const snapshot = async (): Promise<unknown> => {
    const db = new DatabaseSync(cardd.db, { readOnly: true });
    const attempts = db.prepare("SELECT n, host, state, branch FROM attempts ORDER BY id").all();
    const sessions = db.prepare("SELECT id FROM sessions WHERE role = 'worker' ORDER BY id").all();
    db.close();
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    return {
      pid,
      alive: alive(pid),
      workers: await workersOf(lab),
      attempts,
      sessions,
      head: git(tree, "rev-parse", "HEAD"),
      refs: git(scratch.root, "for-each-ref", "--format=%(refname) %(objectname)"),
      status: git(tree, "status", "--porcelain", "--ignored", "--untracked-files=all"),
      tracked: readFileSync(join(tree, ".gitignore"), "utf8"),
      untracked: readFileSync(join(tree, "untracked.txt"), "utf8"),
      ignored: readFileSync(join(tree, "state", "leak.txt"), "utf8"),
      scratch: readdirSync(hostScratch(), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .map((path) => [path, readFileSync(path, "utf8")]),
      archive: existsSync(`${scratch.root}.archive`),
      card: (await cardd.thread(1)).card.status,
    };
  };
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    writeFileSync(join(tree, "product.txt"), "unexpected product change\n");
    git(tree, "add", "product.txt");
    git(tree, "commit", "-qm", "unexpected product change");
    writeFileSync(
      join(tree, ".gitignore"),
      `${readFileSync(join(tree, ".gitignore"), "utf8")}# edited\n`,
    );
    writeFileSync(join(tree, "untracked.txt"), "preserve me\n");
    mkdirSync(join(tree, "state"), { recursive: true });
    writeFileSync(join(tree, "state", "leak.txt"), "ignored but mine\n");
    return {
      tool: "bash",
      args: { command: `echo $PPID > "${pidFile}"; ${workerWrites().args.command}` },
    };
  }, "worker");
  h.onModel((turns) => reportFromWorker(turns), "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  const attempts = [
    { card: 1, summary: "Done" },
    { card: 1, summary: "Done", confirm: true },
    { card: 1, summary: "Not approved", landed: false },
    { card: 1, summary: "Not approved", landed: false, confirm: true },
  ];
  attempts.forEach((args, index) => {
    h.onModel(async (turns) => {
      if (index > 0) {
        answers.push(toolResults(turns).at(-1) ?? "");
        snaps.push(await snapshot());
      } else snaps.push(await snapshot());
      return { tool: "close", args };
    }, "mate");
  });
  h.onModel(async (turns) => {
    answers.push(toolResults(turns).at(-1) ?? "");
    snaps.push(await snapshot());
    return { text: "left open" };
  }, "mate");
  await start();
  await finished(7);
  for (let tries = 0; snaps.length < 5 && tries < 100; tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(snaps.length, 5);
  assert.equal(answers.length, 4);
  const [baseline] = snaps;
  assert.equal(JSON.stringify(baseline).includes('"alive":true'), true);
  assert.equal(JSON.stringify(baseline).includes('"card":"with-mate"'), true);
  snaps.slice(1).forEach((after, index) => {
    assert.deepEqual(after, baseline, `after refusal ${String(index + 1)}`);
  });
  for (const answer of answers)
    assert.match(
      answer,
      /c-1 delivers ops; closing an operation is not available until authoritative retirement lands \(tracked on its own card\); leave it open/,
    );
  assert.equal(
    (await cardd.thread(1)).entries.some((entry) => entry.kind === "cleanup"),
    false,
  );
});

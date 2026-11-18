import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, OPS } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { tempDir } from "../support/run-root.ts";

let fleet: Fleet;
beforeEach(async () => {
  fleet = await startFleet();
});
afterEach(async () => fleet.cardd.stop());

test("the CLI selects ops on one unstarted card, persists it across restart, and keeps the product default", async () => {
  const card = await newCard(fleet.main, "Run the approved operation");
  const changed = fleet.cardd.admin("card", "delivery", String(card.id), "ops");
  assert.equal(changed.status, 0);
  assert.match(changed.stdout, /delivery no-mistakes -> ops/);
  await fleet.cardd.restart();
  const main = await fleet.cardd.connect(fleet.mainToken);
  const begun = check(
    OPS["attempt.begin"].result,
    await main.call("attempt.begin", {
      card: card.id,
      host: "maverick",
      task: "Run it",
    }),
  );
  assert.equal(begun.delivery, "ops");
  const worker = await fleet.cardd.connect(begun.token);
  const [task] = await worker.waitForEntries(1);
  assert.equal(task?.body, "Run it\n\nDelivery: ops");
  const live = fleet.cardd.admin("card", "delivery", String(card.id), "direct-PR");
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /has a live worker/);
  const product = check(
    CardSchema,
    await main.call("card.new", {
      title: "Change the product",
      kind: "ship",
      project: "web",
    }),
  );
  assert.equal(product.delivery, "no-mistakes");
  const rejected = fleet.cardd.admin("project", "delivery", "web", "ops");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /ops is card-only/);
});

test("a card carrying a product PR refuses ops from the CLI, and a running one keeps its mode when dispatch asks for ops", async () => {
  const card = await newCard(fleet.main, "Change the product");
  const begun = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", { card: card.id, host: "maverick", task: "Build it" }),
  );
  const worker = await fleet.cardd.connect(begun.token);
  await worker.call("report", {
    status: "done",
    text: "PR ready",
    pr: "https://github.com/acme/web/pull/8",
  });
  const cli = fleet.cardd.admin("card", "delivery", String(card.id), "ops");
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /a card with a PR cannot change to ops/);
  await assert.rejects(
    fleet.main.call("attempt.begin", {
      card: card.id,
      host: "maverick",
      task: "Run it",
      delivery: "ops",
    }),
    /a running card keeps its delivery mode/,
  );
  const thread = await fleet.cardd.thread(card.id);
  assert.equal(thread.card.delivery, "no-mistakes");
  assert.equal(thread.card.pr, "https://github.com/acme/web/pull/8");
  const view = check(OPS.card.result, await fleet.main.call("card", { card: card.id }));
  assert.equal(view.attempts.length, 1);
});

const evidenceOf = (card: number): string =>
  `/home/worker/.fleet/scratch/c-${String(card)}/operation.md`;

async function operationCard(
  project = "web",
  host = "maverick",
): Promise<{ card: number; session: string; worker: Session }> {
  const made = check(
    CardSchema,
    await fleet.main.call("card.new", {
      title: "Run the approved operation",
      kind: "ship",
      project,
    }),
  );
  assert.equal(fleet.cardd.admin("card", "delivery", String(made.id), "ops").status, 0);
  const begun = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", { card: made.id, host, task: "Run it" }),
  );
  return { card: made.id, session: begun.session, worker: await fleet.cardd.connect(begun.token) };
}

test("only the done report of an ops card carries evidence from its own scratch folder", async () => {
  const product = await newCard(fleet.main, "Change the product");
  const begun = check(
    OPS["attempt.begin"].result,
    await fleet.main.call("attempt.begin", { card: product.id, host: "maverick", task: "Build" }),
  );
  const productWorker = await fleet.cardd.connect(begun.token);
  await assert.rejects(
    productWorker.call("report", {
      status: "done",
      text: "ready",
      evidence: evidenceOf(product.id),
    }),
    /evidence is only for the done report of an ops card/,
  );
  const { card, worker } = await operationCard();
  const evidence = evidenceOf(card);
  await assert.rejects(
    worker.call("report", { status: "working", text: "going", evidence }),
    /evidence is only for the done report of an ops card/,
  );
  await assert.rejects(
    worker.call("report", { status: "done", text: "finished" }),
    /ops completion requires evidence/,
  );
  for (const bad of [
    "relative/report.md",
    "/etc/passwd",
    evidenceOf(card + 1),
    evidence.replace("operation.md", "tmp/operation.md"),
    evidence.replace("operation.md", "../c-9/operation.md"),
  ]) {
    await assert.rejects(
      worker.call("report", { status: "done", text: "finished", evidence: bad }),
      /pattern|ops evidence must be a file in this card's/,
    );
  }
  await assert.rejects(
    worker.call("report", {
      status: "done",
      text: "finished",
      evidence,
      pr: "https://github.com/acme/web/pull/9",
    }),
    /ops work does not report a PR or merge/,
  );
  const thread = await fleet.cardd.thread(card);
  assert.equal(
    thread.entries.some((entry) => entry.fields["evidence"] !== undefined),
    false,
  );
});

test("close.begin on an ops card only reads: it names the effective handoff, adds nothing, and a steer cancels it", async () => {
  const { card, session, worker } = await operationCard();
  const evidence = evidenceOf(card);
  await worker.call("report", { status: "done", text: "finished", evidence });
  const before = (await fleet.cardd.thread(card)).entries.length;
  const plan = check(OPS["close.begin"].result, await fleet.main.call("close.begin", { card }));
  assert.equal(plan.mode, "done");
  assert.deepEqual(plan.refresh, []);
  const { operation } = plan;
  assert.ok(operation);
  assert.equal(operation.session, session);
  assert.equal(operation.evidence, evidence);
  const reports = (await fleet.cardd.thread(card)).entries.filter(
    (entry) => entry.kind === "report" && entry.fields["status"] === "done",
  );
  assert.equal(operation.handoff, reports.at(-1)?.id);
  assert.equal((await fleet.cardd.thread(card)).entries.length, before);
  await worker.call("report", { status: "done", text: "finished again", evidence });
  const again = check(OPS["close.begin"].result, await fleet.main.call("close.begin", { card }));
  assert.ok((again.operation?.handoff ?? 0) > operation.handoff);
  await fleet.main.call("comment", { card, text: "Check one more thing first." });
  await assert.rejects(
    fleet.main.call("close.begin", { card }),
    /the worker has not reported done/,
  );
});

test("the web thread shows that ops evidence was reported, never its path", async () => {
  const { card, worker } = await operationCard();
  await worker.call("report", {
    status: "done",
    text: "finished",
    evidence: evidenceOf(card),
  });
  const thread = await fleet.cardd.thread(card);
  const handoff = thread.entries.find((entry) => entry.fields["evidence"] !== undefined);
  assert.equal(handoff?.fields["evidence"], true);
  assert.doesNotMatch(JSON.stringify(thread), /scratch/);
});

function localRepo(name: string): string {
  const repo = join(tempDir("ops-repo-"), name);
  mkdirSync(repo);
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], {
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  fleet.cardd.addProject(name, { local: repo });
  return repo;
}

const gitIn = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], {
    encoding: "utf8",
  }).trim();

function addTree(repo: string, session: string): string {
  const tree = `${repo}.worktrees/${session}`;
  gitIn(repo, "worktree", "add", "-q", "-b", session, tree, "main");
  return tree;
}

const finishArgs = (card: number): Record<string, unknown> => ({
  card,
  mode: "done",
  text: "Done.",
  archives: [],
  left: [],
});

async function handedOff(project: string): Promise<{
  card: number;
  session: string;
  worker: Session;
  repo: string;
  tree: string;
  handoff: number;
}> {
  const repo = localRepo(project);
  const { card, session, worker } = await operationCard(project, "local");
  const tree = addTree(repo, session);
  await worker.call("report", { status: "done", text: "finished", evidence: evidenceOf(card) });
  const plan = check(OPS["close.begin"].result, await fleet.main.call("close.begin", { card }));
  return { card, session, worker, repo, tree, handoff: plan.operation?.handoff ?? 0 };
}

test("a direct finish with no receipt is refused, and a verified then retired attempt closes Done", async () => {
  const { card, session, repo, tree, handoff } = await handedOff("shop");
  await assert.rejects(
    fleet.main.call("close.finish", finishArgs(card)),
    /has no verified receipt for the current handoff and observed retirement/,
  );
  const verified = await fleet.main.call("close.verify", { card, handoff });
  assert.ok(typeof verified === "object" && verified !== null);
  await assert.rejects(
    fleet.main.call("close.finish", finishArgs(card)),
    /has no verified receipt for the current handoff and observed retirement/,
  );
  gitIn(repo, "worktree", "remove", tree);
  gitIn(repo, "branch", "-D", session);
  await fleet.main.call("close.finish", finishArgs(card));
  const thread = await fleet.cardd.thread(card);
  assert.equal(thread.card.status, "done");
  assert.doesNotMatch(JSON.stringify(thread), /operationReceipt/);
});

test("a missing tree with no receipt, a stale handoff, dirt and a moved clone each refuse the receipt or the finish", async () => {
  const gone = await handedOff("depot");
  gitIn(gone.repo, "worktree", "remove", gone.tree);
  await assert.rejects(
    fleet.main.call("close.verify", { card: gone.card, handoff: gone.handoff }),
    /could not be verified clean or already retired, so nothing was removed/,
  );

  const stale = await handedOff("annex");
  await assert.rejects(
    fleet.main.call("close.verify", { card: stale.card, handoff: stale.handoff - 1 }),
    /handoff changed/,
  );
  await fleet.main.call("close.verify", { card: stale.card, handoff: stale.handoff });
  await stale.worker.call("report", {
    status: "done",
    text: "finished again",
    evidence: evidenceOf(stale.card),
  });
  gitIn(stale.repo, "worktree", "remove", stale.tree);
  gitIn(stale.repo, "branch", "-D", stale.session);
  await assert.rejects(
    fleet.main.call("close.finish", finishArgs(stale.card)),
    /has no verified receipt for the current handoff/,
  );

  const dirty = await handedOff("yard");
  writeFileSync(join(dirty.tree, "late.txt"), "late\n");
  await assert.rejects(
    fleet.main.call("close.verify", { card: dirty.card, handoff: dirty.handoff }),
    /could not be verified clean or already retired/,
  );
  mkdirSync(join(dirty.tree, "state"));
  gitIn(dirty.tree, "checkout", "-q", "-b", "other-work");
  execFileSync("rm", [join(dirty.tree, "late.txt")]);
  await assert.rejects(
    fleet.main.call("close.verify", { card: dirty.card, handoff: dirty.handoff }),
    /could not be verified clean or already retired/,
  );

  const moved = await handedOff("lot");
  await fleet.main.call("close.verify", { card: moved.card, handoff: moved.handoff });
  gitIn(moved.repo, "worktree", "remove", moved.tree);
  gitIn(moved.repo, "branch", "-D", moved.session);
  fleet.cardd.moveClone("lot", "local", `${moved.repo}-elsewhere`);
  await assert.rejects(
    fleet.main.call("close.finish", finishArgs(moved.card)),
    /has no verified receipt for the current handoff and observed retirement/,
  );
});

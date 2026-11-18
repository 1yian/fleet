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

function addTree(repo: string, session: string): string {
  const tree = `${repo}.worktrees/${session}`;
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", `task-${session}`, tree, "main"]);
  return tree;
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

test("an attempt that cannot be checked is listed as unverified and blocks a direct finish", async () => {
  const { card, session, worker } = await operationCard();
  await worker.call("report", { status: "done", text: "finished", evidence: evidenceOf(card) });
  const plan = check(OPS["close.begin"].result, await fleet.main.call("close.begin", { card }));
  assert.equal(plan.mode, "done");
  assert.deepEqual(plan.refresh, []);
  const { operation } = plan;
  assert.ok(operation);
  assert.equal(operation.session, session);
  assert.equal(operation.evidence, evidenceOf(card));
  assert.match(operation.unverified.join(" "), /could not be checked/);
  await assert.rejects(
    fleet.main.call("close.finish", { card, mode: "done", text: "Done.", archives: [], left: [] }),
    /no clean check of every attempt's worktree/,
  );
  assert.equal((await fleet.cardd.thread(card)).card.status, "with-mate");
});

test("a direct finish with no begin is refused, and the checked worktree lets close finish", async () => {
  const repo = localRepo("shop");
  const { card, session, worker } = await operationCard("shop", "local");
  const tree = addTree(repo, session);
  await worker.call("report", { status: "done", text: "finished", evidence: evidenceOf(card) });
  const finish = { card, mode: "done", text: "Done.", archives: [], left: [] };
  await assert.rejects(
    fleet.main.call("close.finish", finish),
    /no clean check of every attempt's worktree/,
  );
  const plan = check(OPS["close.begin"].result, await fleet.main.call("close.begin", { card }));
  assert.deepEqual(plan.operation?.unverified, []);
  const notes = (await fleet.cardd.thread(card)).entries.filter(
    (entry) => entry.author === "cardd" && entry.fields["operationVerified"] !== undefined,
  );
  assert.equal(notes.length, 1);
  assert.equal(
    execFileSync("git", ["-C", tree, "status", "--porcelain"], { encoding: "utf8" }),
    "",
  );
  await fleet.main.call("close.finish", finish);
  assert.equal((await fleet.cardd.thread(card)).card.status, "done");
});

test("a check older than the worker's handoff is stale, and a dirty worktree is not verified", async () => {
  const repo = localRepo("depot");
  const { card, session, worker } = await operationCard("depot", "local");
  const tree = addTree(repo, session);
  const evidence = evidenceOf(card);
  await worker.call("report", { status: "done", text: "finished", evidence });
  const finish = { card, mode: "done", text: "Done.", archives: [], left: [] };
  await fleet.main.call("close.begin", { card });
  await worker.call("report", { status: "done", text: "finished again", evidence });
  await assert.rejects(fleet.main.call("close.finish", finish), /no clean check/);
  writeFileSync(join(tree, "late.txt"), "late\n");
  const dirty = check(OPS["close.begin"].result, await fleet.main.call("close.begin", { card }));
  assert.match(dirty.operation?.unverified.join(" ") ?? "", /1 uncommitted file/);
  await assert.rejects(fleet.main.call("close.finish", finish), /no clean check/);
  execFileSync("rm", [join(tree, "late.txt")]);
  const clean = check(OPS["close.begin"].result, await fleet.main.call("close.begin", { card }));
  assert.deepEqual(clean.operation?.unverified, []);
  await fleet.main.call("close.finish", finish);
  assert.equal((await fleet.cardd.thread(card)).card.status, "done");
});

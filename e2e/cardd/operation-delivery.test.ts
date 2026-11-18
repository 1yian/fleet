import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("the web thread shows that ops evidence was reported, never its path, even when a later report names an earlier one", async () => {
  const { card, worker } = await operationCard();
  const first = evidenceOf(card);
  const second = first.replace("operation.md", "second.md");
  await worker.call("report", { status: "done", text: `finished, see ${first}`, evidence: first });
  await fleet.main.call("comment", { card, text: "One more check." });
  await worker.call("report", {
    status: "done",
    text: `again, instead of ${first}, see ${second}`,
    evidence: second,
  });
  const thread = await fleet.cardd.thread(card);
  const handoffs = thread.entries.filter((entry) => entry.fields["evidence"] !== undefined);
  assert.equal(handoffs.length, 2);
  for (const handoff of handoffs) assert.equal(handoff.fields["evidence"], true);
  assert.doesNotMatch(JSON.stringify(thread), /operation\.md|second\.md|scratch/);
});

function localRepo(name: string): string {
  const repo = join(tempDir("ops-repo-"), name);
  mkdirSync(repo);
  writeFileSync(join(repo, ".gitignore"), "ignored/\n");
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "add", ".gitignore");
  gitIn(repo, "commit", "-qm", "init");
  fleet.cardd.addProject(name, { local: repo });
  return repo;
}

const gitIn = (repo: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], {
    encoding: "utf8",
  }).trim();

test("closing an ops card is refused by begin and finish in both modes, and leaves the live attempt and every file as they were", async () => {
  const repo = localRepo("shop");
  const { card, session, worker } = await operationCard("shop", "local");
  const tree = `${repo}.worktrees/${session}`;
  gitIn(repo, "worktree", "add", "-q", "-b", session, tree, "main");
  writeFileSync(join(tree, "product.txt"), "unexpected product change\n");
  gitIn(tree, "add", "product.txt");
  gitIn(tree, "commit", "-qm", "unexpected product change");
  writeFileSync(join(tree, "untracked.txt"), "preserve me\n");
  mkdirSync(join(tree, "ignored"));
  writeFileSync(join(tree, "ignored", "leak.txt"), "ignored but mine\n");
  await worker.call("report", { status: "done", text: "finished", evidence: evidenceOf(card) });
  const head = gitIn(tree, "rev-parse", "HEAD");
  const branches = gitIn(repo, "branch", "--list");
  const refusal =
    /delivers ops; closing an operation is not available until authoritative retirement lands \(tracked on its own card\); leave it open/;
  for (const landed of [undefined, false]) {
    await assert.rejects(
      fleet.main.call("close.begin", { card, ...(landed === undefined ? {} : { landed }) }),
      refusal,
    );
    const mode = landed === false ? "dropped" : "done";
    await assert.rejects(
      fleet.main.call("close.finish", { card, mode, text: "Done.", archives: [], left: [] }),
      refusal,
    );
  }
  const thread = await fleet.cardd.thread(card);
  assert.equal(thread.card.status, "with-mate");
  assert.equal(
    thread.entries.some((entry) => entry.kind === "cleanup"),
    false,
  );
  const view = check(OPS.card.result, await fleet.main.call("card", { card }));
  assert.deepEqual(
    view.attempts.map((attempt) => attempt.state),
    ["active"],
  );
  assert.equal(gitIn(tree, "rev-parse", "HEAD"), head);
  assert.equal(gitIn(repo, "branch", "--list"), branches);
  assert.equal(readFileSync(join(tree, "untracked.txt"), "utf8"), "preserve me\n");
  assert.equal(readFileSync(join(tree, "ignored", "leak.txt"), "utf8"), "ignored but mine\n");
  assert.equal(existsSync(`${repo}.archive`), false);
  await worker.call("report", { status: "working", text: "still here" });
});

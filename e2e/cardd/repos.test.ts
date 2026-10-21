import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { CardSchema, check, OPS } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { branchOf } from "../support/fleet.ts";

const FAR_HOST = fileURLToPath(new URL("../support/far-host.ts", import.meta.url));
const SWITCH = fileURLToPath(new URL("../support/switch-transport.ts", import.meta.url));
const MOUNT = "/fleet-far-host/";
const WAIT_MS = 10_000;

let cardd: Cardd | undefined;
afterEach(async () => {
  await cardd?.stop();
  cardd = undefined;
});

async function shipDone(main: Session, c: Cardd, project: string, host: string, pr: string) {
  const card = check(
    CardSchema,
    await main.call("card.new", { title: "Users see one scrollbar", kind: "ship", project }),
  );
  const begun = await main.call("attempt.begin", { card: card.id, host, task: "the task" });
  const worker = await c.connect(check(OPS["attempt.begin"].result, begun).token);
  c.gh.setHead(pr, branchOf(card));
  await worker.call("report", { status: "done", text: `PR ${pr} green` });
  return { card, worker };
}

async function closePlan(main: Session, card: number) {
  return check(OPS["close.begin"].result, await main.call("close.begin", { card }));
}

async function planOnceChecked(main: Session, card: number) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const plan = await closePlan(main, card);
    if (!plan.verify || Date.now() > deadline) return plan;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a project whose only clone is on another host gets its repo from there, so close sees its merged PR", async () => {
  const disk = mkdtempSync(join(tmpdir(), "fleet-far-"));
  const clone = `${MOUNT}cleo`;
  mkdirSync(join(disk, clone), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", join(disk, clone)]);
  execFileSync("git", [
    "-C",
    join(disk, clone),
    "remote",
    "add",
    "origin",
    "git@github.com:acme/cleo.git",
  ]);
  const down = join(disk, "far-down");
  writeFileSync(down, "down");
  const hang = join(disk, "stuck-hangs");
  writeFileSync(hang, "hang");
  const hosts = {
    far: ["node", FAR_HOST, down, MOUNT, disk],
    stuck: ["node", SWITCH, hang],
  };
  const c = await Cardd.start({ CARDD_TIMING_SCALE: "0.001" }, ["--hosts", JSON.stringify(hosts)]);
  cardd = c;
  const token = c.addLane("main");
  c.addProject("stuck", { stuck: "/clones/stuck" });
  c.addProject("cleo", { far: clone });
  await c.restart();
  const main = await c.connect(token);

  const pr = "https://github.com/acme/cleo/pull/2447";
  c.gh.setPr(pr, "MERGED");
  const { card } = await shipDone(main, c, "cleo", "far", pr);
  const unknown = await closePlan(main, card.id);
  assert.deepEqual([unknown.mode, unknown.verify], ["done", true]);
  assert.equal(
    unknown.noRepoHint,
    `c-${String(card.id)}'s project cleo has no GitHub repo on record, so close cannot see whether its PR merged. Set it on the cardd host with \`cardd project repo cleo <owner>/<name> --db <cards.db>\`, then close again`,
  );

  rmSync(down);
  const plan = await planOnceChecked(main, card.id);
  assert.deepEqual([plan.mode, plan.verify, plan.noRepoHint], ["done", false, undefined]);
  assert.equal((await c.board()).cards.find((each) => each.id === card.id)?.pr, pr);
});

test("project repo sets and corrects a project's GitHub repo, and close then finds the PR there", async () => {
  const c = await Cardd.start();
  cardd = c;
  const main = await c.connect(c.addLane("main"));
  c.addProject("web", { p620: "/clones/web" });
  const pr = "https://github.com/acme/web/pull/7";
  c.gh.setPr(pr, "MERGED");

  assert.equal(c.setRepo("web", "acme/old-web"), "web: repo acme/old-web");
  const { card, worker } = await shipDone(main, c, "web", "p620", pr);
  const missed = await main.waitForEntry((entry) => entry.kind === "report", "the report");
  assert.equal(missed.fields["prNote"], `no PR has branch ${branchOf(card)} as its head`);

  assert.equal(c.setRepo("web", "acme/web"), "web: repo acme/web");
  await worker.call("report", { status: "done", text: `PR ${pr} merged` });
  const plan = await closePlan(main, card.id);
  assert.deepEqual([plan.mode, plan.verify, plan.noRepoHint], ["done", false, undefined]);

  assert.throws(() => c.setRepo("web", "acme"), {
    stderr: /project repo acme must be <owner>\/<name>/,
  });
  assert.throws(() => c.setRepo("nope", "acme/nope"), {
    stderr: /project nope is not in the registry/,
  });
});

test("a card whose PR is on record closes as Done once it merged, even with no repo on record", async () => {
  const c = await Cardd.start();
  cardd = c;
  const main = await c.connect(c.addLane("main"));
  c.addProject("Cleo", { p620: "/clones/Cleo" });
  const pr = "https://github.com/Aiva-Labs-AI/Cleo/pull/2447";
  c.gh.setPr(pr, "OPEN", { ci: "pass" });
  const { card } = await shipDone(main, c, "Cleo", "p620", pr);
  c.recordPrByHand(card.id, pr);

  await assert.rejects(main.call("close.begin", { card: card.id }), {
    message: `c-${String(card.id)} did not land: its PR ${pr} has not merged. Once the merge is authorized (yolo on with green checks, or the captain's word for this PR), comment the worker to merge it, then close it. To end it anyway, call close(card, summary=<why it is dropped>, landed=false). That marks it Dropped and archives its work.`,
  });
  c.gh.setPr(pr, "MERGED");
  const plan = await closePlan(main, card.id);
  assert.deepEqual([plan.mode, plan.verify, plan.noRepoHint], ["done", false, undefined]);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import {
  branchesOf,
  lastUser,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  worktreesOf,
} from "../support/dispatch-lab.ts";
import { Harness, type Pi } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { git, tip } from "../support/remote.ts";
import { Scratch } from "../support/scratch.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
let scratch: Scratch;
let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let mate: Pi;
let report: string;

beforeEach(async () => {
  scratch = new Scratch();
  cardd = await Cardd.start();
  h = await Harness.start();
  report = join(scratch.parent, "evidence", "operation.md");
  const token = cardd.addLane("main", undefined, scratch.root);
  cardd.addProject("fleet", { local: scratch.root }, undefined, "no-mistakes");
  cardd.yolo("fleet");
  lab = await HerdrLab.start({ ...h.piEnv("worker"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
  mate = h.startPi(
    "main",
    {
      FLEET_URL: cardd.url,
      FLEET_TOKEN: token,
      FLEET_ROLE: "mate",
      FLEET_FAKE_AGENT: "mate",
      HERDR_SESSION: lab.name,
      FLEET_PI_ARGS: JSON.stringify(h.piArgs()),
    },
    [EXTENSION],
  );
});

afterEach(async (t) => {
  await lab.printIfFailed(t);
  await lab.stop();
  await h.stop();
  await cardd.stop();
  scratch.dispose();
});

function dispatchOperation(): void {
  h.onModel(() => ({ tool: "board", args: {} }), "mate");
  h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Record the approved operation",
        name: "approved-operation",
        kind: "ship",
        project: "fleet",
        intent: "Run the approved operation without code changes",
        host: "local",
        task: "Record the operation evidence.",
        delivery: "ops",
      },
    }),
    "mate",
  );
  h.onModel(() => ({ text: "dispatched" }), "mate");
}

function completed(): { tool: string; args: { status: string; text: string; evidence: string } } {
  mkdirSync(join(scratch.parent, "evidence"), { recursive: true });
  writeFileSync(
    report,
    "# Operation\n\nThe approved action completed. Observed state: ready. No project changes.\n",
  );
  return {
    tool: "report",
    args: { status: "done", text: `Operation complete: ${report}`, evidence: report },
  };
}

async function start(): Promise<void> {
  await h.waitFor((event) => event["type"] === "fleet_connected", "mate connected");
  mate.prompt("Run the approved operation.");
}

async function result(call: number): Promise<string> {
  return toolResults(await h.waitForCall(call, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
}

test("ops dispatch hands the worker a no-PR contract, delivers evidence to the mate and board, and closes without changing product defaults", async () => {
  dispatchOperation();
  const before = tip(scratch.root);
  h.onModel(async (turns) => {
    assert.match(lastUser(turns) ?? "", /Delivery: ops$/);
    const contract = turns.find((turn) => turn.role === "system")?.text ?? "";
    assert.match(contract, /### Delivery: ops/);
    assert.match(contract, /No PR, commit, push, or merge is expected/);
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    return completed();
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel((turns) => {
    assert.match(lastUser(turns) ?? "", /operation complete.*no PR expected/i);
    assert.doesNotMatch(lastUser(turns) ?? "", /no PR URL reported/);
    return { tool: "board", args: { card: 1 } };
  }, "mate");
  h.onModel(
    () => ({ tool: "close", args: { card: 1, summary: `Operation verified: ${report}` } }),
    "mate",
  );
  h.onModel(() => ({ text: "closed" }), "mate");
  await start();
  assert.match(await result(4), /delivery: ops/);
  assert.match(await result(4), /operation\.md/);
  assert.equal(await result(5), "c-1 is done.");
  assert.equal((await cardd.thread(1)).card.status, "done");
  assert.match(readFileSync(report, "utf8"), /Observed state: ready/);
  assert.equal(tip(scratch.root), before);
  assert.deepEqual(worktreesOf(scratch.root), ["branch refs/heads/main"]);
  assert.deepEqual(branchesOf(scratch.root), ["main"]);
  assert.deepEqual(await workersOf(lab), []);
  assert.match(cardd.admin("project", "list").stdout, /fleet: no-mistakes/);
  const forbidden = cardd.admin("project", "delivery", "fleet", "ops");
  assert.notEqual(forbidden.status, 0);
  assert.match(forbidden.stderr, /ops is card-only/);
});

test("ops refuses a done handoff without evidence and refuses PR or merged claims", async () => {
  dispatchOperation();
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    return { tool: "report", args: { status: "done", text: "finished" } };
  }, "worker");
  h.onModel((turns) => {
    assert.match(toolResults(turns).at(-1) ?? "", /ops completion requires evidence/);
    return {
      tool: "report",
      args: { ...completed().args, pr: "https://github.com/acme/fleet/pull/8", merged: true },
    };
  }, "worker");
  h.onModel((turns) => {
    assert.match(toolResults(turns).at(-1) ?? "", /ops work does not report a PR or merge/);
    return { tool: "report", args: { ...completed().args, status: "merged" } };
  }, "worker");
  h.onModel((turns) => {
    assert.match(toolResults(turns).at(-1) ?? "", /ops work does not report a PR or merge/);
    return completed();
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: `Verified ${report}` } }), "mate");
  h.onModel(() => ({ text: "closed" }), "mate");
  await start();
  assert.equal(await result(4), "c-1 is done.");
  const thread = await cardd.thread(1);
  assert.equal(thread.card.pr, null);
  assert.equal(
    thread.entries.filter((entry) => entry.kind === "report" && entry.fields["status"] === "done")
      .length,
    1,
  );
});

test("ops refuses a missing completion report and cannot close Done", async () => {
  dispatchOperation();
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    return { tool: "report", args: { status: "done", text: "Operation complete", evidence: report } };
  }, "worker");
  h.onModel(
    (turns) =>
      /ops completion evidence.*readable/.test(toolResults(turns).at(-1) ?? "")
        ? { tool: "report", args: { status: "failed", text: "Evidence report is missing" } }
        : { text: "reported" },
    "worker",
  );
  h.onModel(() => ({ text: "handed off" }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Operation complete" } }), "mate");
  h.onModel(() => ({ text: "close attempted" }), "mate");
  await start();
  assert.match(await result(4), /the worker has not reported done/);
  const thread = await cardd.thread(1);
  assert.equal(thread.card.status, "with-mate");
  assert.equal(
    thread.entries.some((entry) => entry.kind === "report" && entry.fields["status"] === "done"),
    false,
  );
});

test("ops refuses Done if accepted completion evidence disappears", async () => {
  dispatchOperation();
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    return completed();
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => {
    unlinkSync(report);
    return { tool: "close", args: { card: 1, summary: "Operation complete", confirm: true } };
  }, "mate");
  h.onModel(() => ({ text: "close attempted" }), "mate");
  await start();
  assert.match(await result(4), /cannot close Done.*ops completion evidence is not readable/);
  assert.equal((await cardd.thread(1)).card.status, "with-mate");
  assert.equal(existsSync(`${scratch.root}.worktrees/c-1-a1`), true);
});

test("ops warns about unexpected committed and untracked changes, refuses confirm, and preserves them when explicitly dropped", async () => {
  dispatchOperation();
  const before = tip(scratch.root);
  const tree = `${scratch.root}.worktrees/c-1-a1`;
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    writeFileSync(join(tree, "product.txt"), "unexpected product change\n");
    git(tree, "add", "product.txt");
    git(tree, "commit", "-qm", "unexpected product change");
    writeFileSync(join(tree, "untracked.txt"), "preserve me\n");
    return completed();
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Operation complete" } }), "mate");
  h.onModel((turns) => {
    const warning = toolResults(turns).at(-1) ?? "";
    assert.match(warning, /1 commit not on main and 1 uncommitted file/);
    assert.match(warning, /product change/);
    assert.match(warning, /untracked\.txt/);
    return { tool: "close", args: { card: 1, summary: "Operation complete", confirm: true } };
  }, "mate");
  h.onModel(async (turns) => {
    assert.match(
      toolResults(turns).at(-1) ?? "",
      /ops cannot confirm unexpected code changes as landed/,
    );
    assert.equal((await cardd.thread(1)).card.status, "with-mate");
    assert.equal(existsSync(join(tree, "untracked.txt")), true);
    return {
      tool: "close",
      args: {
        card: 1,
        summary: "Unexpected changes are not approved; preserve them",
        landed: false,
      },
    };
  }, "mate");
  h.onModel(() => ({ text: "dropped" }), "mate");
  await start();
  const archive = `${scratch.root}.archive/c-1-a1.tar.zst`;
  assert.equal(await result(6), `c-1 is dropped. Unlanded work is archived in local:${archive}.`);
  const packed = execFileSync("zstd", ["-dc", archive]);
  const bundle = join(scratch.parent, "preserved.bundle");
  writeFileSync(
    bundle,
    execFileSync("tar", ["-xOf", "-", "c-1-a1/commits.bundle"], { input: packed }),
  );
  assert.match(git(scratch.root, "bundle", "list-heads", bundle), /HEAD/);
  assert.match(
    execFileSync("tar", ["-tf", "-"], { input: packed, encoding: "utf8" }),
    /commits\.bundle/,
  );
  const untracked = execFileSync("tar", ["-xOf", "-", "c-1-a1/untracked.tar"], { input: packed });
  assert.equal(
    execFileSync("tar", ["-xOf", "-", "untracked.txt"], { input: untracked, encoding: "utf8" }),
    "preserve me\n",
  );
  assert.equal(tip(scratch.root), before);
  assert.match(readFileSync(report, "utf8"), /Observed state/);
});

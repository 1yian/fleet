import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
import { Harness, type Pi, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { git, tip } from "../support/remote.ts";
import { Scratch } from "../support/scratch.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const hostScratch = (): string => join(process.env["FLEET_HOST_DIR"] ?? "", "scratch");

let scratch: Scratch;
let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let mate: Pi;
let report: string;
let tree: string;

beforeEach(async () => {
  rmSync(hostScratch(), { recursive: true, force: true });
  scratch = new Scratch();
  cardd = await Cardd.start();
  h = await Harness.start();
  report = join(hostScratch(), "c-1", "operation.md");
  tree = `${scratch.root}.worktrees/c-1-a1`;
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
      FLEET_PI_ARGS: JSON.stringify([...h.piArgs(), "-e", SHELL]),
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
  h.onModel(() => {
    git(scratch.root, "remote", "add", "origin", join(scratch.parent, "unreachable.git"));
    return { tool: "board", args: {} };
  }, "mate");
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

function written(path: string): { tool: string; args: Record<string, string> } {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    "# Operation\n\nThe approved action completed. Observed state: ready. No project changes.\n",
  );
  return {
    tool: "report",
    args: {
      status: "done",
      text: "Operation complete; the evidence report is attached",
      evidence: path,
    },
  };
}

async function start(): Promise<void> {
  await h.waitFor((event) => event["type"] === "fleet_connected", "mate connected");
  mate.prompt("Run the approved operation.");
}

const finished = (call: number): Promise<Turn[]> => h.waitForCall(call, "mate", WORKER_WAIT_MS);

const closedFolders = (): string[] =>
  readdirSync(hostScratch()).filter((name) => name.startsWith("c-1.closed-"));

const LAUNCHER = `
const { spawn } = require("node:child_process");
const [cwd, script] = process.argv.slice(2);
spawn("sh", ["-c", script], { cwd, detached: true, stdio: "ignore" }).unref();
`;

function startLateWriter(): { tool: string; args: { command: string } } {
  const launcher = join(h.dir, "launch.cjs");
  const pidFile = join(h.dir, "writer.pid");
  writeFileSync(launcher, LAUNCHER);
  const script = `echo $$ > "${pidFile}"; trap "echo late > late.txt; exit 0" TERM; while :; do sleep 0.05; done`;
  const wait = `i=0; while [ ! -s "${pidFile}" ]; do i=$((i+1)); [ $i -gt 100 ] && exit 1; sleep 0.1; done`;
  return {
    tool: "bash",
    args: { command: `node "${launcher}" "$PWD" '${script}'\n${wait}` },
  };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function archivedUntracked(archive: string, file: string): string {
  const packed = execFileSync("zstd", ["-dc", archive]);
  const untracked = execFileSync("tar", ["-xOf", "-", "c-1-a1/untracked.tar"], { input: packed });
  return execFileSync("tar", ["-xOf", "-", file], { input: untracked, encoding: "utf8" });
}

test("ops runs offline, hands evidence over in its own field, closes clean, and keeps the report after close", async () => {
  dispatchOperation();
  const refs = git(scratch.root, "for-each-ref");
  const before = tip(scratch.root);
  const seen: string[] = [];
  h.onModel(async (turns) => {
    assert.match(lastUser(turns) ?? "", /Delivery: ops$/);
    const contract = turns.find((turn) => turn.role === "system")?.text ?? "";
    assert.match(contract, /### Delivery: ops/);
    assert.match(contract, /No PR, commit, push, or merge is expected/);
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    return written(report);
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel((turns) => {
    assert.match(lastUser(turns) ?? "", /operation complete.*no PR expected/i);
    assert.doesNotMatch(lastUser(turns) ?? "", /no PR URL reported/);
    return { tool: "board", args: { card: 1 } };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { tool: "close", args: { card: 1, summary: "Operation verified" } };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { tool: "board", args: { card: 1 } };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { text: "closed" };
  }, "mate");
  await start();
  await finished(6);
  const [open, closed, after] = seen;
  assert.match(open ?? "", /delivery: ops/);
  assert.match(open ?? "", new RegExp(`report: "?${report}"?`));
  assert.doesNotMatch(open ?? "", /retained/);
  assert.equal(closed, "c-1 is done.");
  const retained = closedFolders();
  assert.equal(retained.length, 1);
  assert.match(
    after ?? "",
    new RegExp(`retained: "?local:${hostScratch()}/c-1\\.closed-\\*/operation\\.md"?`),
  );
  assert.match(
    readFileSync(join(hostScratch(), retained[0] ?? "", "operation.md"), "utf8"),
    /Observed state: ready/,
  );
  assert.equal(existsSync(join(hostScratch(), "c-1")), false);
  assert.equal((await cardd.thread(1)).card.status, "done");
  assert.equal(tip(scratch.root), before);
  assert.equal(git(scratch.root, "for-each-ref"), refs);
  assert.deepEqual(worktreesOf(scratch.root), ["branch refs/heads/main"]);
  assert.deepEqual(branchesOf(scratch.root), ["main"]);
  assert.deepEqual(await workersOf(lab), []);
  assert.match(cardd.admin("project", "list").stdout, /fleet: no-mistakes/);
  const forbidden = cardd.admin("project", "delivery", "fleet", "ops");
  assert.notEqual(forbidden.status, 0);
  assert.match(forbidden.stderr, /ops is card-only/);
});

test("ops refuses a done handoff without evidence, evidence on other statuses, and PR or merge claims", async () => {
  dispatchOperation();
  const attempt = { status: "done", text: "finished" };
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    return { tool: "report", args: attempt };
  }, "worker");
  h.onModel((turns) => {
    assert.match(toolResults(turns).at(-1) ?? "", /ops completion requires evidence/);
    return { tool: "report", args: { status: "working", text: "going", evidence: report } };
  }, "worker");
  h.onModel((turns) => {
    assert.match(
      toolResults(turns).at(-1) ?? "",
      /evidence is only for the done report of an ops card/,
    );
    return {
      tool: "report",
      args: { ...written(report).args, pr: "https://github.com/acme/fleet/pull/8", merged: true },
    };
  }, "worker");
  h.onModel((turns) => {
    assert.match(toolResults(turns).at(-1) ?? "", /ops work does not report a PR or merge/);
    return { tool: "report", args: { ...written(report).args, status: "merged" } };
  }, "worker");
  h.onModel((turns) => {
    assert.match(toolResults(turns).at(-1) ?? "", /ops work does not report a PR or merge/);
    return written(report);
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Verified" } }), "mate");
  h.onModel(() => ({ text: "closed" }), "mate");
  await start();
  const turns = await finished(4);
  assert.equal(toolResults(turns).at(-1), "c-1 is done.");
  const thread = await cardd.thread(1);
  assert.equal(thread.card.pr, null);
  assert.equal(
    thread.entries.filter((entry) => entry.kind === "report" && entry.fields["status"] === "done")
      .length,
    1,
  );
});

const UNREADABLE = [
  {
    name: "outside the card's scratch folder",
    place: (): string => join(scratch.parent, "evidence", "operation.md"),
    remove: false,
  },
  {
    name: "in the tmp folder that close removes",
    place: (): string => join(hostScratch(), "c-1", "tmp", "operation.md"),
    remove: false,
  },
  { name: "gone before close", place: (): string => report, remove: true },
];

for (const { name, place, remove } of UNREADABLE) {
  test(`ops refuses Done and keeps the attempt when the evidence is ${name}`, async () => {
    dispatchOperation();
    h.onModel(async () => {
      await h.waitForCall(2, "mate", WORKER_WAIT_MS);
      return written(place());
    }, "worker");
    h.onModel(() => ({ text: "reported" }), "worker");
    h.onModel(() => {
      if (remove) unlinkSync(place());
      return { tool: "close", args: { card: 1, summary: "Operation complete", confirm: true } };
    }, "mate");
    h.onModel(() => ({ text: "close attempted" }), "mate");
    await start();
    const turns = await finished(4);
    assert.match(
      toolResults(turns).at(-1) ?? "",
      /cannot close Done.*not a readable report in the card's scratch folder/,
    );
    assert.equal((await cardd.thread(1)).card.status, "with-mate");
    assert.equal(existsSync(tree), true);
    assert.equal(existsSync(`${scratch.root}.archive`), false);
  });
}

test("ops refuses Done for unexpected commits and files even with confirm, and preserves them until an explicit drop", async () => {
  dispatchOperation();
  const before = tip(scratch.root);
  const seen: string[] = [];
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    writeFileSync(join(tree, "product.txt"), "unexpected product change\n");
    git(tree, "add", "product.txt");
    git(tree, "commit", "-qm", "unexpected product change");
    writeFileSync(join(tree, "untracked.txt"), "preserve me\n");
    return written(report);
  }, "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Operation complete" } }), "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { tool: "close", args: { card: 1, summary: "Operation complete", confirm: true } };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return {
      tool: "close",
      args: {
        card: 1,
        summary: "Unexpected changes are not approved; preserve them",
        landed: false,
      },
    };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { text: "dropped" };
  }, "mate");
  await start();
  await finished(6);
  const [plain, confirmed, dropped] = seen;
  for (const refusal of [plain ?? "", confirmed ?? ""]) {
    assert.match(refusal, /1 commit not on main and 1 uncommitted file, left in place/);
    assert.match(refusal, /product change/);
    assert.match(refusal, /untracked\.txt/);
    assert.match(refusal, /cannot end Done with unexpected code changes, even with confirm=true/);
  }
  const archive = `${scratch.root}.archive/c-1-a1.tar.zst`;
  assert.equal(dropped, `c-1 is dropped. Unlanded work is archived in local:${archive}.`);
  const packed = execFileSync("zstd", ["-dc", archive]);
  const bundle = join(scratch.parent, "preserved.bundle");
  writeFileSync(
    bundle,
    execFileSync("tar", ["-xOf", "-", "c-1-a1/commits.bundle"], { input: packed }),
  );
  assert.match(git(scratch.root, "bundle", "list-heads", bundle), /HEAD/);
  assert.equal(archivedUntracked(archive, "untracked.txt"), "preserve me\n");
  assert.equal(tip(scratch.root), before);
  const kept = closedFolders();
  assert.match(
    readFileSync(join(hostScratch(), kept[0] ?? "", "operation.md"), "utf8"),
    /Observed/,
  );
});

test("ops refuses Done for a writer that is still running when close stops it, and preserves what it wrote", async () => {
  dispatchOperation();
  const seen: string[] = [];
  h.onModel(async () => {
    await h.waitForCall(2, "mate", WORKER_WAIT_MS);
    return startLateWriter();
  }, "worker");
  h.onModel(() => written(report), "worker");
  h.onModel(() => ({ text: "reported" }), "worker");
  h.onModel(() => ({ tool: "close", args: { card: 1, summary: "Operation complete" } }), "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { tool: "close", args: { card: 1, summary: "Not approved", landed: false } };
  }, "mate");
  h.onModel((turns) => {
    seen.push(toolResults(turns).at(-1) ?? "");
    return { text: "dropped" };
  }, "mate");
  await start();
  await finished(5);
  const [refused, dropped] = seen;
  assert.match(refused ?? "", /c-1 was not closed\. c-1-a1 on local has 1 uncommitted file/);
  assert.match(refused ?? "", /late\.txt/);
  assert.match(dropped ?? "", /^c-1 is dropped\. .*Unlanded work is archived in local:/);
  const pid = Number(readFileSync(join(h.dir, "writer.pid"), "utf8").trim());
  assert.equal(alive(pid), false);
  assert.equal(archivedUntracked(`${scratch.root}.archive/c-1-a1.tar.zst`, "late.txt"), "late\n");
  assert.equal((await cardd.thread(1)).card.status, "dropped");
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FilesFleet } from "../support/files-fleet.ts";
import { refreshClone } from "../support/refresh.ts";
import { git, landOnRemote, tip } from "../support/remote.ts";

let fleet: FilesFleet;
beforeEach(async () => {
  fleet = await FilesFleet.start();
});
afterEach(async () => {
  await fleet.stop();
});

const scratchOf = (): string => `${fleet.clone}.worktrees/scratch`;
const agents = (): string => join(fleet.home, "AGENTS.md");
const branchOf = (dir: string): string => git(dir, "rev-parse", "--abbrev-ref", "HEAD");
const branches = (): string[] =>
  git(fleet.clone, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);

function edit(path: string): { status: number; stdout: string; stderr: string } {
  fleet.forgetEditorCalls();
  return fleet.files(["edit", path]);
}

test("E on a tracked file in a lane home opens the same file in a new scratch worktree off origin/main", () => {
  const run = edit(agents());
  assert.equal(run.status, 0, run.stderr);
  assert.ok(existsSync(scratchOf()));
  assert.match(branchOf(scratchOf()), /^scratch\/p620-\d{8}-\d{6}$/);
  assert.equal(tip(scratchOf(), "HEAD"), tip(fleet.remote));
  assert.throws(() => git(scratchOf(), "rev-parse", "--abbrev-ref", "@{upstream}"));
  const start = tip(scratchOf(), "HEAD").slice(0, 12);
  assert.match(run.stdout, new RegExp(`creating the scratch worktree of fleet: ${scratchOf()}`));
  assert.match(
    run.stdout,
    new RegExp(`branch ${branchOf(scratchOf())}, from origin/main at ${start}`),
  );
  const call = fleet.editorCalls().at(0);
  assert.equal(call?.cwd, scratchOf());
  assert.equal(call.args.at(-1), join(scratchOf(), "AGENTS.md"));
  assert.equal(call.args.includes("-R"), false);
  assert.match(
    call.args.find((arg) => arg.startsWith("let &statusline")) ?? "",
    /SCRATCH, scratch\/p620-/,
  );
  assert.equal(
    readFileSync(agents(), "utf8"),
    readFileSync(join(scratchOf(), "AGENTS.md"), "utf8"),
  );
});

test("a second E reuses the scratch, and E on a private file just opens it", () => {
  edit(agents());
  const first = branchOf(scratchOf());
  const again = edit(join(fleet.home, "README.md"));
  assert.equal(again.stdout, "");
  assert.equal(branchOf(scratchOf()), first);
  assert.equal(fleet.editorCalls()[0]?.args.at(-1), join(scratchOf(), "README.md"));
  const note = join(fleet.home, "data", "note.md");
  writeFileSync(note, "mine\n");
  const run = edit(note);
  assert.equal(run.stdout, "");
  assert.equal(fleet.editorCalls()[0]?.args.at(-1), note);
  assert.equal(fleet.editorCalls()[0]?.cwd, process.cwd());
});

test("the update check, lane discovery and the clone refresh never see a scratch worktree, and a change on the remote moves the clone and not the scratch", () => {
  edit(agents());
  const scratchBranch = branchOf(scratchOf());
  const scratchHead = tip(scratchOf(), "HEAD");
  const env = { ...process.env, ...fleet.env() };
  const update = execFileSync("node", [fleet.scratch.launch, "update", "--check"], {
    encoding: "utf8",
    env,
  });
  assert.deepEqual(JSON.parse(update), { state: "ready", root: fleet.scratch.root });
  const secrets = execFileSync("node", [fleet.scratch.launch, "secrets"], {
    encoding: "utf8",
    env,
  });
  assert.deepEqual(
    secrets
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(":")[0]),
    ["main", "cleo"],
  );
  assert.match(refreshClone(fleet.clone), /already current/);
  const landed = landOnRemote(fleet.remote, "elsewhere");
  const refreshed = refreshClone(fleet.clone);
  assert.doesNotMatch(refreshed, /STUCK/);
  assert.equal(tip(fleet.clone), landed);
  assert.equal(tip(scratchOf(), "HEAD"), scratchHead);
  assert.equal(branchOf(scratchOf()), scratchBranch);
  assert.ok(branches().includes(scratchBranch));
});

test("a merged scratch branch whose remote branch is deleted survives the clone refresh while the scratch holds it", () => {
  edit(agents());
  const branch = branchOf(scratchOf());
  writeFileSync(join(scratchOf(), "work.md"), "work\n");
  git(scratchOf(), "add", "work.md");
  git(scratchOf(), "commit", "-q", "-m", "work");
  const pushed = fleet.files(["push"], {}, scratchOf());
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.match(pushed.stdout, new RegExp(`pushed ${branch} to origin/${branch}`));
  assert.equal(git(fleet.remote, "rev-parse", branch), tip(scratchOf(), "HEAD"));
  assert.equal(git(scratchOf(), "rev-parse", "--abbrev-ref", "@{upstream}"), `origin/${branch}`);
  git(fleet.remote, "branch", "-D", branch);
  const refreshed = refreshClone(fleet.clone);
  assert.doesNotMatch(refreshed, /STUCK/);
  assert.ok(branches().includes(branch));
});

test("scratch lists each scratch with its branch, how far it is from origin, its dirty files and whether reset is allowed", () => {
  assert.match(fleet.files(["scratch"]).stdout, /no scratch worktree on this host yet/);
  edit(agents());
  const branch = branchOf(scratchOf());
  writeFileSync(join(scratchOf(), "dirty.md"), "x\n");
  landOnRemote(fleet.remote, "elsewhere");
  git(scratchOf(), "fetch", "-q", "origin");
  const listed = fleet.files(["scratch"]).stdout;
  assert.equal(
    listed,
    `fleet: ${scratchOf()} on ${branch}, 0 ahead and 1 behind origin/main, 1 dirty files, reset refuses while the scratch is dirty\n`,
  );
  git(scratchOf(), "add", "dirty.md");
  git(scratchOf(), "commit", "-q", "-m", "mine");
  assert.match(
    fleet.files(["scratch"]).stdout,
    /1 ahead and 1 behind origin\/main, 0 dirty files, has commits that are not merged, reset refuses/,
  );
});

test("scratch reset refuses dirty files and unmerged commits, and moves a merged scratch onto a fresh branch off origin/main", () => {
  edit(agents());
  const old = branchOf(scratchOf());
  writeFileSync(join(scratchOf(), "dirty.md"), "x\n");
  const dirty = fleet.files(["scratch", "reset"]);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /has 1 dirty files/);
  git(scratchOf(), "add", "dirty.md");
  git(scratchOf(), "commit", "-q", "-m", "mine");
  const unmerged = fleet.files(["scratch", "reset"]);
  assert.equal(unmerged.status, 1);
  assert.match(unmerged.stderr, new RegExp(`${old} has commits that are not merged`));
  assert.equal(branchOf(scratchOf()), old);
  fleet.files(["push"], {}, scratchOf());
  const landed = landOnRemote(fleet.remote, "squash of mine", "dirty.md", "x\n");
  git(fleet.remote, "branch", "-D", old);
  const reset = fleet.files(["scratch", "reset"]);
  assert.equal(reset.status, 0, reset.stderr);
  const fresh = branchOf(scratchOf());
  assert.notEqual(fresh, old);
  assert.match(fresh, /^scratch\/p620-/);
  assert.equal(tip(scratchOf(), "HEAD"), landed);
  assert.equal(branches().includes(old), false);
  assert.match(reset.stdout, new RegExp(`is on ${fresh} from origin/main, and ${old} is deleted`));
});

test("scratch reset keeps a pushed branch whose remote branch was deleted without a merge", () => {
  edit(agents());
  const old = branchOf(scratchOf());
  writeFileSync(join(scratchOf(), "work.md"), "work\n");
  git(scratchOf(), "add", "work.md");
  git(scratchOf(), "commit", "-q", "-m", "work");
  const mine = tip(scratchOf(), "HEAD");
  assert.equal(fleet.files(["push"], {}, scratchOf()).status, 0);
  git(fleet.remote, "branch", "-D", old);
  const reset = fleet.files(["scratch", "reset"]);
  assert.equal(reset.status, 1);
  assert.match(reset.stderr, new RegExp(`${old} has commits that are not merged`));
  assert.equal(branchOf(scratchOf()), old);
  assert.equal(tip(scratchOf(), "HEAD"), mine);
  assert.ok(branches().includes(old));
  assert.match(
    fleet.files(["scratch"]).stdout,
    /1 ahead and 0 behind origin\/main, 0 dirty files, has commits that are not merged, reset refuses/,
  );
});

test("a local-only project's scratch starts from, is measured against, and resets onto its local base", async () => {
  await fleet.stop();
  fleet = await FilesFleet.start({ delivery: "local-only" });
  git(fleet.clone, "commit", "-q", "--allow-empty", "-m", "local only work");
  const local = tip(fleet.clone);
  const run = edit(agents());
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`from main at ${local.slice(0, 12)}`));
  assert.equal(tip(scratchOf(), "HEAD"), local);
  const old = branchOf(scratchOf());
  assert.equal(
    fleet.files(["scratch"]).stdout,
    `fleet: ${scratchOf()} on ${old}, 0 ahead and 0 behind main, 0 dirty files, reset allowed\n`,
  );
  const reset = fleet.files(["scratch", "reset"]);
  assert.equal(reset.status, 0, reset.stderr);
  const fresh = branchOf(scratchOf());
  assert.notEqual(fresh, old);
  assert.equal(tip(scratchOf(), "HEAD"), local);
  assert.match(reset.stdout, new RegExp(`is on ${fresh} from main, and ${old} is deleted`));
});

test("E makes a scratch for a local-only repository that has no origin at all", () => {
  const solo = join(fleet.scratch.parent, "solo");
  execFileSync("git", ["init", "-q", "-b", "main", solo]);
  writeFileSync(join(solo, "README.md"), "solo\n");
  git(solo, "add", "README.md");
  git(solo, "commit", "-q", "-m", "readme");
  fleet.cardd.addProject("solo", { p620: solo }, undefined, "local-only");
  const scratch = `${solo}.worktrees/scratch`;
  const run = edit(join(solo, "README.md"));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`from main at ${tip(solo).slice(0, 12)}`));
  assert.equal(tip(scratch, "HEAD"), tip(solo));
  assert.equal(fleet.editorCalls()[0]?.args.at(-1), join(scratch, "README.md"));
  const old = branchOf(scratch);
  assert.equal(
    fleet.files(["scratch"]).stdout,
    `solo: ${scratch} on ${old}, 0 ahead and 0 behind main, 0 dirty files, reset allowed\n`,
  );
  const reset = fleet.files(["scratch", "reset", "solo"]);
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stdout, new RegExp(`from main, and ${old} is deleted`));
});

test("scratch reset takes a new name when the timestamp name is already a branch", () => {
  edit(agents());
  const old = branchOf(scratchOf());
  for (let ahead = 0; ahead < 30; ahead += 1) {
    const stamp = new Date(Date.now() + ahead * 1000)
      .toISOString()
      .replace(/\.\d+Z$/, "")
      .replace(/[-:]/g, "")
      .replace("T", "-");
    const name = `scratch/p620-${stamp}`;
    if (!branches().includes(name)) git(fleet.clone, "branch", name, "main");
  }
  const reset = fleet.files(["scratch", "reset"]);
  assert.equal(reset.status, 0, reset.stderr);
  const fresh = branchOf(scratchOf());
  assert.notEqual(fresh, old);
  assert.match(fresh, /^scratch\/p620-\d{8}-\d{6}-2$/);
  assert.equal(branches().includes(old), false);
});

test("P on a hovered file in the scratch pushes the scratch branch", () => {
  edit(agents());
  const branch = branchOf(scratchOf());
  writeFileSync(join(scratchOf(), "work.md"), "work\n");
  git(scratchOf(), "add", "work.md");
  git(scratchOf(), "commit", "-q", "-m", "work");
  const pushed = fleet.files(["push", join(scratchOf(), "work.md")]);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.match(pushed.stdout, new RegExp(`pushed ${branch} to origin/${branch}`));
  assert.equal(git(fleet.remote, "rev-parse", branch), tip(scratchOf(), "HEAD"));
  const outside = fleet.files(["push", join(fleet.home, "AGENTS.md")]);
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /this is not a scratch worktree/);
});

test("E opens a scratch copy that links back to a guarded file read-only, and shows metadata for a scratch copy that is binary", () => {
  edit(agents());
  const copy = join(scratchOf(), "AGENTS.md");
  rmSync(copy);
  symlinkSync(join(fleet.clone, "AGENTS.md"), copy);
  const linked = edit(agents());
  assert.equal(linked.status, 0, linked.stderr);
  const call = fleet.editorCalls().at(0);
  assert.ok(call !== undefined);
  assert.ok(call.args.includes("-R") && call.args.includes("-M"));
  assert.match(
    call.args.find((arg) => arg.startsWith("let &statusline")) ?? "",
    /GUARDED, tracked in the fleet clone/,
  );
  writeFileSync(join(scratchOf(), "README.md"), Buffer.from([0, 1, 2, 3]));
  const binary = edit(join(fleet.home, "README.md"));
  assert.equal(binary.status, 0, binary.stderr);
  assert.match(binary.stdout, /not opened in a text editor: a binary file/);
  assert.deepEqual(fleet.editorCalls(), []);
});

test("E says how far the scratch is ahead of the lane's checkout when the remote moved on", () => {
  landOnRemote(fleet.remote, "elsewhere");
  edit(agents());
  const status = fleet.editorCalls()[0]?.args.find((arg) => arg.startsWith("let &statusline"));
  assert.match(status ?? "", /1 commits ahead of this lane''s checkout/);
});

test("E refuses a worker's worktree, a released skill outside the skills lane, and a repository with no clone on this host, and makes no scratch", () => {
  const worker = join(`${fleet.clone}.worktrees`, "c-7-a1");
  git(fleet.clone, "worktree", "add", "-q", "-b", "c-7-a1", worker);
  const refusedWorker = edit(join(worker, "AGENTS.md"));
  assert.equal(refusedWorker.status, 1);
  assert.match(
    refusedWorker.stderr,
    /a worker owns this worktree. S shows a file to this lane's mate/,
  );
  const skill = edit(join(fleet.userHome, ".agents", "skills", "lavish", "SKILL.md"));
  assert.equal(skill.status, 1);
  assert.match(
    skill.stderr,
    /skills are edited in the lane that owns them. M sends a request to main/,
  );
  git(
    fleet.scratch.root,
    "remote",
    "set-url",
    "origin",
    join(fleet.scratch.parent, "elsewhere.git"),
  );
  const unknown = edit(agents());
  assert.equal(unknown.status, 1);
  assert.match(
    unknown.stderr,
    /this host has no clone of the repository this file belongs to: register one first/,
  );
  assert.equal(existsSync(scratchOf()), false);
  assert.deepEqual(fleet.editorCalls(), []);
});

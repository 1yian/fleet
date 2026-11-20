import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { addRemote, git } from "../support/remote.ts";
import { Scratch } from "../support/scratch.ts";

const PROBE = "e2e/hook-probe.ts";
const BROKEN = 'export const probe : number = "text" // comment\n';
const FIXED = "export const probe = 1;\n";

let scratch: Scratch;
let remote: string;
beforeEach(() => {
  scratch = new Scratch();
  remote = addRemote(scratch.root);
  execFileSync("node", ["githooks.js", "install"], { cwd: scratch.root });
});
afterEach(() => {
  scratch.dispose();
});

const push = (...args: string[]) =>
  spawnSync("git", ["-C", scratch.root, "push", ...args, "origin", "HEAD"], { encoding: "utf8" });

const remoteBranches = (): string => git(remote, "branch", "--list", "feat/*");

function commitProbe(content: string): void {
  writeFileSync(join(scratch.root, PROBE), content);
  git(scratch.root, "add", PROBE);
  git(scratch.root, "commit", "-q", "-m", "probe");
}

test("the install step points git at the checked-in hooks", () => {
  assert.equal(git(scratch.root, "config", "core.hooksPath"), ".githooks");
});

test("a push of a file that fails format, lint and typecheck is refused", () => {
  git(scratch.root, "switch", "-q", "-c", "feat/broken");
  commitProbe(BROKEN);
  const result = push();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pre-push: checking 1 changed files/);
  assert.match(result.stderr, /pre-push: format, lint, typecheck failed/);
  assert.ok(result.stderr.includes(PROBE), result.stderr);
  assert.equal(remoteBranches(), "");
});

test("the same push goes through once the file is clean, and --no-verify skips the hook", () => {
  git(scratch.root, "switch", "-q", "-c", "feat/clean");
  commitProbe(FIXED);
  const clean = push();
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stderr, /pre-push: passed in/);
  assert.match(remoteBranches(), /feat\/clean/);

  git(scratch.root, "switch", "-q", "-c", "feat/skipped");
  commitProbe(BROKEN);
  const skipped = push("--no-verify");
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.doesNotMatch(skipped.stderr, /pre-push:/);
  assert.match(remoteBranches(), /feat\/skipped/);
});

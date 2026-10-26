import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Scratch } from "../support/scratch.ts";

function fleet(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const scratch = new Scratch();
  try {
    const run = spawnSync("node", [scratch.launch, ...args], { encoding: "utf8" });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  } finally {
    scratch.dispose();
  }
}

test("fleet --help prints usage and exits 0", () => {
  for (const flag of ["--help", "-h"]) {
    const run = fleet([flag]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^usage: fleet status \|/);
    assert.equal(run.stderr, "");
  }
});

test("fleet with an unknown option prints a short error and usage, not a stack trace", () => {
  const run = fleet(["status", "--bogus"]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^fleet: Unknown option '--bogus'/);
  assert.match(run.stderr, /usage: fleet status \|/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
});

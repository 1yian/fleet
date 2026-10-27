import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));

const GREEN = [
  { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
  { __typename: "StatusContext", context: "legacy-ci", state: "SUCCESS" },
];
const RED_AND_PENDING = [
  { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "FAILURE" },
  { __typename: "CheckRun", name: "ci-ok", status: "IN_PROGRESS", conclusion: "" },
  { __typename: "StatusContext", context: "legacy-ci", state: "PENDING" },
];

let fleet: Fleet;
let h: Harness;
let bin: string;
let merged: string;
let checks: string;

beforeEach(async () => {
  fleet = await startFleet({});
  h = await Harness.start();
  bin = join(h.dir, "bin");
  merged = join(h.dir, "merged");
  checks = join(h.dir, "checks.json");
  mkdirSync(bin);
  const file = join(bin, "gh");
  writeFileSync(
    file,
    `#!/bin/sh
case "$1 $2" in
  "pr view") cat "${checks}" ;;
  *) touch "${merged}" ;;
esac
`,
  );
  chmodSync(file, 0o755);
});
afterEach(async () => {
  const stopped = await Promise.allSettled([h.stop(), fleet.cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function workerRuns(command: string, rollup: unknown): Promise<string> {
  writeFileSync(
    checks,
    JSON.stringify({ headRefOid: "abc123def4567890", statusCheckRollup: rollup }),
  );
  h.onModel(() => ({ tool: "bash", args: { command } }));
  h.onModel(() => ({ text: "done" }));
  const token = await begin(fleet.main, await newCard(fleet.main, "Merge it"));
  const pi = h.startPi(
    "worker",
    {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: token,
      FLEET_ROLE: "worker",
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    },
    [EXTENSION, SHELL],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "the worker to connect");
  pi.prompt("merge it");
  await h.waitForCall(1);
  return JSON.stringify(h.calls[1]);
}

const MERGES: readonly [string, string][] = [
  ["gh pr merge https://github.com/o/r/pull/7 --squash", "url"],
  ["gh pr merge 7 --admin --squash", "admin"],
  ["gh pr merge --auto --merge", "auto"],
  ["gh pr merge my-branch -R o/r --rebase", "branch with repo"],
  ["echo go && (gh pr merge 7 --squash)", "compound"],
  ["gh api -X PUT repos/o/r/pulls/7/merge -f merge_method=squash", "api put"],
];

for (const [command, label] of MERGES) {
  test(`a worker is refused a merge (${label}) while a check is red or pending`, async () => {
    const result = await workerRuns(command, RED_AND_PENDING);
    assert.match(result, /not every check on the PR's head commit abc123def456/);
    assert.match(result, /e2e: failure/);
    assert.match(result, /ci-ok: in progress/);
    assert.match(result, /legacy-ci: pending/);
    assert.match(result, /run_long/);
    assert.equal(existsSync(merged), false);
  });
}

for (const [command, label] of MERGES) {
  test(`a worker may merge (${label}) when every check is green`, async () => {
    const result = await workerRuns(command, GREEN);
    assert.doesNotMatch(result, /refused/);
    assert.equal(existsSync(merged), true);
  });
}

test("a worker may merge a PR that has no checks", async () => {
  const result = await workerRuns("gh pr merge 7 --squash", []);
  assert.doesNotMatch(result, /refused/);
  assert.equal(existsSync(merged), true);
});

test("a worker is refused a GraphQL merge", async () => {
  const result = await workerRuns(
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }'",
    GREEN,
  );
  assert.match(result, /GraphQL merge mutation/);
  assert.equal(existsSync(merged), false);
});

test("a worker is refused a merge when the check lookup fails", async () => {
  const result = await workerRuns("gh pr merge 7 --squash", null);
  assert.match(result, /could not look up the PR's checks/);
  assert.equal(existsSync(merged), false);
});
